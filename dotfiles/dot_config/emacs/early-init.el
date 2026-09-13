;;; early-init.el --- Load Helheim bootstrap -*- lexical-binding: t; no-byte-compile: t -*-

;;; Commentary:

;; Bootstrap Helheim and configure startup and terminal behavior.

;;; Code:

(load (expand-file-name "~/.local/share/helheim/early-init.el") nil t)

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

(defun evy-autoloads-if-changed (generate &rest args)
  "Run GENERATE with ARGS only when the Lisp source inventory changes."
  (let* ((output (expand-file-name ".user-lisp-autoloads.el"
                                   user-lisp-directory))
         (cache (expand-file-name "autoload-source-stamp.eld"
                                  user-emacs-directory))
         (sources
          (mapcar
           (lambda (file)
             (let ((attributes (file-attributes file)))
               (list file (file-attribute-size attributes)
                     (file-attribute-modification-time attributes))))
           (sort
            (delete output (directory-files-recursively
                            user-lisp-directory (rx ".el" string-end)))
            #'string-lessp)))
         (previous
          (when (file-readable-p cache)
            (condition-case nil
                (with-temp-buffer
                  (insert-file-contents cache)
                  (read (current-buffer)))
              (error nil)))))
    (when (or (called-interactively-p 'any)
              (not (file-readable-p output))
              (not (file-readable-p cache))
              (not (equal sources previous)))
      (apply generate args)
      (make-directory (file-name-directory cache) t)
      (with-temp-file cache
        (let ((print-length nil) (print-level nil))
          (prin1 sources (current-buffer)))))))

(with-eval-after-load 'helheim-lib
  (advice-add 'helheim-regenerate-autoloads :around
              #'evy-autoloads-if-changed))

;; The early file must remain source-loaded before load-prefer-newer is set.
(with-eval-after-load 'compile-angel
  (add-to-list 'compile-angel-excluded-path-regexps
               (rx "/.config/emacs/early-init.el" string-end))
  ;; Homebrew's optional site-load.el has no source to compile.
  (add-to-list 'compile-angel-excluded-path-regexps
               (rx "/site-load.el" string-end)))

(provide 'early-init)
;;; early-init.el ends here
