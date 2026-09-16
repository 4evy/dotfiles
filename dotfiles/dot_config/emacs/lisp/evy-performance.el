;;; evy-performance.el --- Keep long-line files responsive -*- lexical-binding: t -*-

;;; Commentary:

;; Apply Emacs' long-line safeguards to logs and prose as well as source code.

;;; Code:

(require 'cl-lib)
(require 'so-long)

(defun evy-long-line-buffer-p ()
  "Whether this buffer needs protection from expensive editing features."
  (or (derived-mode-p 'so-long-mode)
      (bound-and-true-p so-long-minor-mode)
      (save-restriction
        (widen)
        (funcall so-long-predicate))))

(defun evy-so-long-file-buffer ()
  "Protect file buffers immediately; defer changes to internal buffers."
  (if buffer-file-name
      (so-long)
    (so-long-deferred)))

;; The default targets omit text-mode, so large .txt logs go unprotected.
(add-to-list 'so-long-target-modes 'text-mode)
(setq so-long-invisible-buffer-function #'evy-so-long-file-buffer)

;; Helheim keeps fontification and line numbers in the minor-mode fallback.
;; Both remain expensive when a file has a line millions of characters long.
(dolist (mode '(font-lock-mode display-line-numbers-mode whitespace-mode
                diff-hl-mode flymake-mode sideline-mode apheleia-mode))
  (add-to-list 'so-long-minor-modes mode))

;; Scope display compromises to affected buffers, including daemon clients.
;; Normal prose retains bidirectional rendering.  Keep long lines truncated.
(dolist (entry '((bidi-display-reordering . nil)
                 (bidi-inhibit-bpa . t)
                 (truncate-lines . t)
                 (line-move-visual . nil)
                 (column-number-mode . nil)
                 (apheleia-inhibit . t)))
  (setf (alist-get (car entry) so-long-variable-overrides) (cdr entry)))

(global-so-long-mode 1)

(provide 'evy-performance)
;;; evy-performance.el ends here
