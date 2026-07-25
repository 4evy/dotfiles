#!/usr/bin/env python3.14
"""Set Logitech HID++ 2.0 MULTIPLATFORM OS mode for the current host."""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import struct
import sys
import time
from typing import TypedDict

HIDPP_LONG_MESSAGE_ID = 0x11
HIDPP_DEVNUMBER_BT = 0xFF
HIDPP_SOFTWARE_ID = 0x0B
LOGITECH_VENDOR_ID = 0x046D
FEATURE_SET = 0x0001
MULTIPLATFORM = 0x4531
OS_BITS = {
    "windows": 0x0100,
    "linux": 0x0400,
    "chrome": 0x0800,
    "android": 0x1000,
    "macos": 0x2000,
    "ios": 0x4000,
    "webos": 0x8000,
}


class HidApiError(RuntimeError):
    pass


class DeviceInfo(ctypes.Structure):
    pass


class HidDevice(TypedDict):
    path: bytes | None
    vendor_id: int
    product_id: int
    serial: str | None
    manufacturer: str | None
    product: str | None
    usage_page: int
    usage: int
    interface: int


def load_hidapi() -> ctypes.CDLL:
    candidates = [
        ctypes.util.find_library("hidapi"),
        "/opt/homebrew/lib/libhidapi.dylib",
        "/usr/local/lib/libhidapi.dylib",
        "libhidapi.dylib",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            hidapi = ctypes.cdll.LoadLibrary(candidate)
            break
        except OSError:
            continue
    else:
        raise HidApiError("could not load libhidapi; install Homebrew package 'hidapi'")

    class HidApiVersion(ctypes.Structure):
        _fields_ = [
            ("major", ctypes.c_int),
            ("minor", ctypes.c_int),
            ("patch", ctypes.c_int),
        ]

    hidapi.hid_version.argtypes = []
    hidapi.hid_version.restype = ctypes.POINTER(HidApiVersion)
    version = hidapi.hid_version().contents

    fields = [
        ("path", ctypes.c_char_p),
        ("vendor_id", ctypes.c_ushort),
        ("product_id", ctypes.c_ushort),
        ("serial_number", ctypes.c_wchar_p),
        ("release_number", ctypes.c_ushort),
        ("manufacturer_string", ctypes.c_wchar_p),
        ("product_string", ctypes.c_wchar_p),
        ("usage_page", ctypes.c_ushort),
        ("usage", ctypes.c_ushort),
        ("interface_number", ctypes.c_int),
        ("next", ctypes.POINTER(DeviceInfo)),
    ]
    if version.major > 0 or version.minor >= 13:
        fields.append(("bus_type", ctypes.c_int))
    DeviceInfo._fields_ = fields

    hidapi.hid_init.argtypes = []
    hidapi.hid_init.restype = ctypes.c_int
    hidapi.hid_enumerate.argtypes = [ctypes.c_ushort, ctypes.c_ushort]
    hidapi.hid_enumerate.restype = ctypes.POINTER(DeviceInfo)
    hidapi.hid_free_enumeration.argtypes = [ctypes.POINTER(DeviceInfo)]
    hidapi.hid_open_path.argtypes = [ctypes.c_char_p]
    hidapi.hid_open_path.restype = ctypes.c_void_p
    hidapi.hid_write.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]
    hidapi.hid_write.restype = ctypes.c_int
    hidapi.hid_read_timeout.argtypes = [
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.c_size_t,
        ctypes.c_int,
    ]
    hidapi.hid_read_timeout.restype = ctypes.c_int
    hidapi.hid_close.argtypes = [ctypes.c_void_p]
    hidapi.hid_close.restype = None
    hidapi.hid_error.argtypes = [ctypes.c_void_p]
    hidapi.hid_error.restype = ctypes.c_wchar_p

    if hidapi.hid_init() != 0:
        raise HidApiError("hid_init failed")
    if sys.platform == "darwin" and hasattr(hidapi, "hid_darwin_set_open_exclusive"):
        hidapi.hid_darwin_set_open_exclusive.argtypes = [ctypes.c_int]
        hidapi.hid_darwin_set_open_exclusive.restype = None
        hidapi.hid_darwin_set_open_exclusive(0)
    return hidapi


def hid_error(hidapi: ctypes.CDLL, handle: ctypes.c_void_p | None = None) -> str:
    error = hidapi.hid_error(handle)
    return error or "unknown hidapi error"


def enumerate_devices(
    hidapi: ctypes.CDLL, vendor_id: int, product_id: int
) -> list[HidDevice]:
    devices: list[HidDevice] = []
    head = hidapi.hid_enumerate(vendor_id, product_id)
    current = head
    try:
        while current:
            info = current.contents
            devices.append({
                "path": info.path,
                "vendor_id": info.vendor_id,
                "product_id": info.product_id,
                "serial": info.serial_number,
                "manufacturer": info.manufacturer_string,
                "product": info.product_string,
                "usage_page": info.usage_page,
                "usage": info.usage,
                "interface": info.interface_number,
            })
            current = info.next
    finally:
        hidapi.hid_free_enumeration(head)
    return devices


def choose_path(devices: list[HidDevice], product_name: str | None) -> bytes | None:
    if product_name:
        devices = [d for d in devices if d["product"] == product_name]
    if not devices:
        return None

    priority = {0xFF43: 0, 0xFF0C: 1, 0x0001: 2, 0x000C: 3}
    devices = sorted(devices, key=lambda d: priority.get(d["usage_page"], 9))
    path = devices[0]["path"]
    return path if isinstance(path, bytes) else None


def open_path(hidapi: ctypes.CDLL, path: bytes) -> ctypes.c_void_p:
    handle = hidapi.hid_open_path(path)
    if not handle:
        message = hid_error(hidapi)
        if "not permitted" in message:
            message += "; grant Input Monitoring to the terminal running dotfiles setup"
        elif "exclusive access" in message:
            message += "; stop Kanata before changing Logitech platform mode"
        raise HidApiError(message)
    return handle


def hid_write(hidapi: ctypes.CDLL, handle: ctypes.c_void_p, data: bytes) -> None:
    written = hidapi.hid_write(handle, data, len(data))
    if written < 0:
        raise HidApiError(hid_error(hidapi, handle))


def hid_read(hidapi: ctypes.CDLL, handle: ctypes.c_void_p, timeout_ms: int) -> bytes:
    buf = ctypes.create_string_buffer(32)
    size = hidapi.hid_read_timeout(handle, buf, len(buf), timeout_ms)
    if size < 0:
        raise HidApiError(hid_error(hidapi, handle))
    return bytes(buf.raw[:size])


def flush_input(hidapi: ctypes.CDLL, handle: ctypes.c_void_p) -> None:
    while hid_read(hidapi, handle, 0):
        pass


def request(
    hidapi: ctypes.CDLL,
    handle: ctypes.c_void_p,
    request_id: int,
    params: bytes = b"",
    timeout: float = 4.0,
) -> bytes:
    request_id = (request_id & 0xFFF0) | HIDPP_SOFTWARE_ID
    request_data = struct.pack("!H", request_id) + params
    frame = struct.pack(
        "!BB18s", HIDPP_LONG_MESSAGE_ID, HIDPP_DEVNUMBER_BT, request_data
    )

    flush_input(hidapi, handle)
    hid_write(hidapi, handle, frame)

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        data = hid_read(
            hidapi, handle, int(max(0.05, deadline - time.monotonic()) * 1000)
        )
        if not data:
            continue
        if len(data) != 20 or data[0] != HIDPP_LONG_MESSAGE_ID:
            continue
        devnumber = data[1]
        if devnumber not in {HIDPP_DEVNUMBER_BT, HIDPP_DEVNUMBER_BT ^ 0xFF}:
            continue
        payload = data[2:]
        if payload[0] == 0xFF and payload[1:3] == request_data[:2]:
            raise HidApiError(
                f"HID++ feature request 0x{request_id:04x} failed with error 0x{payload[3]:02x}"
            )
        if payload[:2] == request_data[:2]:
            return payload[2:]
    raise HidApiError(f"timed out waiting for HID++ request 0x{request_id:04x}")


def get_feature_index(
    hidapi: ctypes.CDLL, handle: ctypes.c_void_p, feature: int
) -> int | None:
    reply = request(hidapi, handle, 0x0000, struct.pack("!H", feature))
    if not reply or reply[0] == 0:
        return None
    return reply[0]


def enumerate_features(hidapi: ctypes.CDLL, handle: ctypes.c_void_p) -> dict[int, int]:
    feature_set_index = get_feature_index(hidapi, handle, FEATURE_SET)
    if feature_set_index is None:
        return {}

    count_reply = request(hidapi, handle, feature_set_index << 8)
    feature_count = count_reply[0] + 1
    features = {0x0000: 0, FEATURE_SET: feature_set_index}

    for index in range(1, feature_count):
        reply = request(hidapi, handle, (feature_set_index << 8) | 0x10, bytes([index]))
        if len(reply) >= 2:
            features[struct.unpack("!H", reply[:2])[0]] = index
    return features


def os_names(os_flags: int) -> list[str]:
    return [name for name, bit in OS_BITS.items() if os_flags & bit]


def choose_platform(
    descriptors: list[tuple[int, int]], platform: int | None, os_name: str | None
) -> int:
    if platform is not None:
        return platform
    if os_name is None:
        raise HidApiError("either --platform or --os is required")
    os_bit = OS_BITS[os_name.lower()]
    for descriptor_platform, os_flags in descriptors:
        if os_flags & os_bit:
            return descriptor_platform
    raise HidApiError(f"keyboard does not advertise an OS platform for {os_name}")


def set_multiplatform(
    hidapi: ctypes.CDLL,
    handle: ctypes.c_void_p,
    target_platform: int | None,
    target_os: str | None,
) -> bool:
    features = enumerate_features(hidapi, handle)
    multiplatform_index = features.get(MULTIPLATFORM)
    if multiplatform_index is None:
        print("logitech-platform: MULTIPLATFORM feature is not available")
        return False

    info = request(hidapi, handle, multiplatform_index << 8)
    if len(info) < 7:
        raise HidApiError(f"unexpected MULTIPLATFORM info payload: {info.hex()}")
    flags, _, descriptor_count = struct.unpack("!BBB", info[:3])
    current_platform = info[6]
    if not flags & 0x02:
        print("logitech-platform: keyboard reports MULTIPLATFORM as read-only")
        return False

    descriptors = []
    for index in range(descriptor_count):
        descriptor = request(
            hidapi, handle, (multiplatform_index << 8) | 0x10, bytes([index])
        )
        if len(descriptor) < 8:
            continue
        platform, _, os_flags, _, _ = struct.unpack("!BBHHH", descriptor[:8])
        descriptors.append((platform, os_flags))

    desired_platform = choose_platform(descriptors, target_platform, target_os)
    descriptor_text = ", ".join(
        f"{platform}:{'/'.join(os_names(os_flags)) or hex(os_flags)}"
        for platform, os_flags in descriptors
    )
    print(
        "logitech-platform: "
        f"current={current_platform} desired={desired_platform} descriptors=[{descriptor_text}]"
    )

    if current_platform == desired_platform:
        print("logitech-platform: already configured")
        return False

    request(
        hidapi,
        handle,
        (multiplatform_index << 8) | 0x30,
        bytes([0xFF, desired_platform]),
    )
    updated = request(hidapi, handle, multiplatform_index << 8)
    if len(updated) < 7 or updated[6] != desired_platform:
        raise HidApiError(f"MULTIPLATFORM write did not stick: {updated.hex()}")
    print("logitech-platform: updated current host platform")
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--vendor-id", type=lambda value: int(value, 0), default=LOGITECH_VENDOR_ID
    )
    parser.add_argument("--product-id", type=lambda value: int(value, 0), required=True)
    parser.add_argument("--product-name")
    parser.add_argument("--platform", type=lambda value: int(value, 0))
    parser.add_argument("--os", choices=sorted(OS_BITS))
    parser.add_argument(
        "--strict",
        action="store_true",
        help="fail if the target device is not connected",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    hidapi = load_hidapi()
    devices = enumerate_devices(hidapi, args.vendor_id, args.product_id)
    path = choose_path(devices, args.product_name)
    if path is None:
        message = f"logitech-platform: no matching Logitech device 0x{args.product_id:04x} is connected"
        print(message)
        return 1 if args.strict else 0

    handle = open_path(hidapi, path)
    try:
        set_multiplatform(hidapi, handle, args.platform, args.os)
    finally:
        hidapi.hid_close(handle)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except HidApiError as error:
        print(f"logitech-platform: {error}", file=sys.stderr)
        raise SystemExit(1) from error
