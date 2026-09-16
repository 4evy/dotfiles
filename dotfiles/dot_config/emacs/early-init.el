;;; early-init.el --- Load Helheim bootstrap -*- lexical-binding: t; no-byte-compile: t -*-

;;; Commentary:

;; Bootstrap Helheim and configure startup and terminal behavior.

;;; Code:

(load (expand-file-name "~/.local/share/helheim/early-init.el") nil t)

;; Keep configuration and compiler warnings visible outside --debug-init too.
(setq warning-minimum-level :warning
      byte-compile-warnings t)

;; Cursor shapes must reach Ghostty, not just Emacs' graphical display.
(setq xterm-update-cursor 'type)

;; The early file must remain source-loaded before load-prefer-newer is set.
(with-eval-after-load 'compile-angel
  (add-to-list 'compile-angel-excluded-path-regexps
               (rx "/.config/emacs/early-init.el" string-end))
  ;; Homebrew's optional site-load.el has no source to compile.
  (add-to-list 'compile-angel-excluded-path-regexps
               (rx "/site-load.el" string-end)))

(provide 'early-init)
;;; early-init.el ends here
