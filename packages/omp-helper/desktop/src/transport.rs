use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_util::sync::{CancellationToken, DropGuard};

const REQUEST_LIMIT_ERROR: &str = "MCP request exceeds encoded byte limit";
const RESPONSE_LIMIT_ERROR: &str = "MCP response exceeds encoded byte limit";

// Keep SDK framing, compatibility parsing and protocol-error replies
// Its private writer exposes no encoder limits; inspection callbacks cannot fail
pub struct BoundedIo<T> {
    inner: T,
    count: usize,
    limit: usize,
    closed: CancellationToken,
    _close_guard: DropGuard,
}

impl<T> BoundedIo<T> {
    pub fn new(inner: T, limit: usize, closed: CancellationToken) -> Self {
        Self {
            inner,
            count: 0,
            limit,
            _close_guard: closed.clone().drop_guard(),
            closed,
        }
    }

    fn count_bytes(&self, buffer: &[u8], message: &'static str) -> io::Result<usize> {
        let mut count = self.count;
        for byte in buffer {
            if *byte == b'\n' {
                count = 0;
            } else if count == self.limit {
                self.closed.cancel();
                return Err(io::Error::new(io::ErrorKind::InvalidData, message));
            } else {
                count += 1;
            }
        }
        Ok(count)
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for BoundedIo<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buffer.filled().len();
        Pin::new(&mut self.inner)
            .poll_read(cx, buffer)
            .map(|result| {
                result.inspect_err(|_| self.closed.cancel())?;
                if buffer.filled().len() == before && buffer.remaining() != 0 {
                    self.closed.cancel();
                }
                // AsyncRead must leave the filled length unchanged on error
                self.count = self
                    .count_bytes(&buffer.filled()[before..], REQUEST_LIMIT_ERROR)
                    .inspect_err(|_| buffer.set_filled(before))?;
                Ok(())
            })
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for BoundedIo<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        let next = self.count_bytes(buffer, RESPONSE_LIMIT_ERROR)?;
        Pin::new(&mut self.inner)
            .poll_write(cx, buffer)
            .map(|result| {
                let written = result.inspect_err(|_| self.closed.cancel())?;
                self.count = if written == buffer.len() {
                    next
                } else {
                    self.count_bytes(&buffer[..written], RESPONSE_LIMIT_ERROR)?
                };
                Ok(written)
            })
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner)
            .poll_flush(cx)
            .map(|result| result.inspect_err(|_| self.closed.cancel()))
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner)
            .poll_shutdown(cx)
            .map(|result| result.inspect_err(|_| self.closed.cancel()))
    }
}
