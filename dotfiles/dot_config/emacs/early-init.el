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

(defun evy-elpaca-reuse-ultra-scroll (enqueue order &rest args)
  "Reuse Hel's `ultra-scroll' dependency for a duplicate ORDER.
Otherwise call ENQUEUE with ORDER and ARGS."
  ;; Elpaca returns a warning string for this duplicate during daemon startup,
  ;; which its declaration expander then mistakes for a package record.
  (or (and (not after-init-time)
           (eq (if (consp order) (car order) order) 'ultra-scroll)
           (elpaca-get 'ultra-scroll))
      (apply enqueue order args)))

(with-eval-after-load 'elpaca
  (advice-add 'elpaca--enqueue :around #'evy-elpaca-reuse-ultra-scroll))

(with-eval-after-load 'term/xterm
  ;; DECSCUSR: steady block in Normal, steady bar in Insert.
  (setq xterm--cursor-type-to-int
        '(nil 0 box 2 hollow 2 bar 6 hbar 4)))

;; The early file must remain source-loaded before load-prefer-newer is set.
(with-eval-after-load 'compile-angel
  (add-to-list 'compile-angel-excluded-path-regexps
               (rx "/.config/emacs/early-init.el" string-end))
  ;; Homebrew's optional site-load.el has no source to compile.
  (add-to-list 'compile-angel-excluded-path-regexps
               (rx "/site-load.el" string-end)))

(provide 'early-init)
;;; early-init.el ends here
