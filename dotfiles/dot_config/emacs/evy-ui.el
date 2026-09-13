;;; evy-ui.el --- Helix-style terminal chrome -*- lexical-binding: t -*-

;;; Commentary:

;; Display file tabs and a compact status line for terminal editing.

;;; Code:

(require 'cl-lib)
(require 'flymake)
(require 'subr-x)
(require 'tab-line)

(declare-function hel-number-of-cursors "hel")
(declare-function hel-update-cursor "hel")
(declare-function doom-modeline-mode "doom-modeline" (&optional arg))

(defface evy-status-normal '((t (:inherit mode-line :weight bold)))
  "Normal-state badge." :group 'mode-line)
(defface evy-status-insert '((t (:inherit mode-line :weight bold)))
  "Insert-state badge." :group 'mode-line)
(defface evy-status-select '((t (:inherit mode-line :weight bold)))
  "Selection-state badge." :group 'mode-line)
(defface evy-status-modified '((t (:inherit warning)))
  "Unsaved file indicator." :group 'mode-line)

(defun evy-mode-line-escape (text)
  "Protect literal percent signs in dynamic mode-line TEXT."
  (string-replace "%" "%%" text))

(defun evy-file-tabs ()
  "List open files, retaining the current buffer in non-file views."
  (let ((files (seq-filter
                (lambda (buffer) (buffer-local-value 'buffer-file-name buffer))
                (buffer-list))))
    (if (memq (current-buffer) files)
        files
      (cons (current-buffer) files))))

(defun evy-indent-width ()
  "Return the indentation width used by the current major mode."
  (or (cl-loop for variable in '(python-indent-offset rust-indent-offset
                                typescript-ts-mode-indent-offset
                                js-indent-level c-basic-offset
                                css-indent-offset sh-basic-offset
                                lisp-indent-offset standard-indent)
               when (and (local-variable-p variable)
                         (integerp (symbol-value variable)))
               return (symbol-value variable))
      tab-width))

(defun evy-status-right ()
  "Describe selections, position, indentation, encoding, and file type."
  (let* ((count (if (and (boundp 'hel--cursors-table)
                        (hash-table-p hel--cursors-table))
                   (hel-number-of-cursors)
                 1))
         (eol (pcase (coding-system-eol-type buffer-file-coding-system)
                (0 "LF") (1 "CRLF") (2 "CR") (_ "?")))
         (encoding (coding-system-base buffer-file-coding-system))
         (diagnostics (when (bound-and-true-p flymake-mode)
                        (flymake-diagnostics)))
         (errors (cl-count :error diagnostics :key #'flymake-diagnostic-type))
         (warnings (cl-count :warning diagnostics :key #'flymake-diagnostic-type)))
    (concat
     (when (> (+ errors warnings) 0)
       (format "E:%d W:%d  " errors warnings))
     ;; Native %l uses redisplay's line cache and large-buffer limits.
     (format "%d sel  %s:%d %d%%  %d %s  %s%s  %s "
             count (format-mode-line "%l")
             (1+ (current-column))
             (/ (* 100 (- (point) (point-min)))
                (max 1 (- (point-max) (point-min))))
             (evy-indent-width) (if indent-tabs-mode "tabs" "spaces")
             (if (memq encoding '(utf-8 utf-8-emacs undecided))
                 "" (format "%s " encoding))
             eol
             (string-remove-suffix "-ts"
                                   (string-remove-suffix "-mode"
                                                         (symbol-name major-mode)))))))

(defun evy-status-line ()
  "Build a Helix-like status line without spawning external processes."
  (let* ((state (cond ((bound-and-true-p hel-insert-state) "INS")
                      ((bound-and-true-p hel--extend-selection) "SEL")
                      ((bound-and-true-p hel-normal-state) "NOR")
                      (t "EMC")))
         (face (pcase state
                 ("INS" 'evy-status-insert)
                 ("SEL" 'evy-status-select)
                 (_ 'evy-status-normal)))
         (right (evy-status-right))
         (revision (string-trim (format-mode-line vc-mode)))
         (wide (> (window-total-width) 100)))
    (list
     (propertize (concat " " state " ") 'face face)
     "  "
     (propertize (evy-mode-line-escape
                  (truncate-string-to-width (buffer-name)
                                            (if wide 32 20) nil nil "…"))
                 'face 'bold)
     (when (buffer-modified-p)
       (propertize " [+]" 'face 'evy-status-modified))
     (when buffer-read-only " [RO]")
     (when (and wide (not (string-empty-p revision)))
       (list (propertize " " 'display
                         `(space :align-to (- center ,(/ (string-width revision) 2))))
             (evy-mode-line-escape revision)))
     (propertize " " 'display
                 `(space :align-to (- right ,(string-width right))))
     (evy-mode-line-escape right))))

(defun evy-enable-status-line ()
  "Keep our status line when Hel enables its own mode indicator."
  (setq-default mode-line-format '((:eval (evy-status-line)))))

(add-hook 'hel-mode-hook #'evy-enable-status-line)

(defun evy-enable-editor-ui ()
  "Apply UI settings after Helheim has configured its packages."
  (when (bound-and-true-p doom-modeline-mode)
    (doom-modeline-mode -1))
  (setopt tab-bar-show nil)
  (tab-bar-mode -1)
  (setq tab-line-tabs-function #'evy-file-tabs
        tab-line-close-button-show nil
        tab-line-new-button-show nil
        tab-line-separator " ")
  (global-tab-line-mode 1)
  (evy-enable-status-line)
  (remove-hook 'prog-mode-hook #'helheim-show-fill-column-indicator)
  (setq-default display-fill-column-indicator nil)
  ;; Use the customization setters so Hel updates its state properties too.
  (setopt hel-normal-state-cursor-type 'box
          hel-insert-state-cursor-type '(bar . 2))
  (blink-cursor-mode -1)
  (dolist (buffer (buffer-list))
    (with-current-buffer buffer
      (setq-local display-fill-column-indicator nil)
      (when (bound-and-true-p hel-local-mode)
        (hel-update-cursor)))))

(add-hook 'elpaca-after-init-hook #'evy-enable-editor-ui 95)

(provide 'evy-ui)
;;; evy-ui.el ends here
