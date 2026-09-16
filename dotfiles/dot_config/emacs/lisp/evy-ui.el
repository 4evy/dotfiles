;;; evy-ui.el --- Compact terminal chrome -*- lexical-binding: t -*-

;;; Commentary:

;; Use Doom Modeline's standard segments and Hel's native state information.

;;; Code:

(require 'helheim-setup)
(eval-when-compile
  (defvar helheim-package-manager 'elpaca))
(require 'tab-line)

(declare-function hel-update-cursor "hel")
(declare-function doom-modeline-set-modeline "doom-modeline-core"
                  (key &optional default))

(setup doom-modeline
  (:install t)
  (:require t)
  (setq doom-modeline-icon nil
        doom-modeline-buffer-file-name-style 'buffer-name
        doom-modeline-buffer-encoding t
        doom-modeline-indent-info t
        doom-modeline-check-icon nil
        doom-modeline-total-line-number nil
        doom-modeline-enable-word-count nil
        doom-modeline-position-column-line-format '("%l:%c")
        doom-modeline-column-zero-based nil)
  ;; Hel owns state tags, cursor counts, and search progress.
  (doom-modeline-def-segment evy-hel
    '(" " (hel-local-mode (:eval (hel-state-mode-line-tag)))
      " " (hel-local-mode hel-mode-line-info)))
  (doom-modeline-def-modeline 'evy
    '(evy-hel buffer-info-simple vcs)
    '(check buffer-position indent-info buffer-encoding major-mode))
  (doom-modeline-mode 1))

(defun evy-enable-status-line ()
  "Apply the compact modeline after Hel configures its state indicator."
  (when (featurep 'doom-modeline)
    (doom-modeline-set-modeline 'evy t)))

(add-hook 'hel-mode-hook #'evy-enable-status-line)

(defun evy-enable-compiler-log-hel ()
  "Restore Hel in compiler logs created with global mode hooks suppressed."
  (when (and (bound-and-true-p hel-mode)
             (derived-mode-p 'emacs-lisp-compilation-mode)
             (not (bound-and-true-p hel-local-mode)))
    (hel-local-mode 1)))

;; Compile Angel suppresses `after-change-major-mode-hook' while compiling.
(add-hook 'emacs-lisp-compilation-mode-hook #'evy-enable-compiler-log-hel)

(defun evy-enable-editor-ui ()
  "Apply UI settings after Helheim has configured its packages."
  (setopt tab-bar-show nil)
  (tab-bar-mode -1)
  (setq tab-line-tabs-function #'tab-line-tabs-fixed-window-buffers
        tab-line-close-button-show nil
        tab-line-new-button-show nil
        tab-line-separator " ")
  (global-tab-line-mode 1)
  (evy-enable-status-line)
  (remove-hook 'prog-mode-hook #'helheim-show-fill-column-indicator)
  (remove-hook 'markdown-mode-hook #'+wrap-line-mode)
  (remove-hook 'markdown-ts-mode-hook #'+wrap-line-mode)
  (setq-default display-fill-column-indicator nil)
  ;; Pad both sides of the colored state labels.
  (setf (hel-state-property 'normal :tag) " NORMAL "
        (hel-state-property 'insert :tag) " INSERT ")
  ;; Use the customization setters so Hel updates its state properties too.
  (setopt hel-normal-state-cursor-type 'box
          hel-insert-state-cursor-type '(bar . 2))
  (blink-cursor-mode -1)
  (dolist (buffer (buffer-list))
    (with-current-buffer buffer
      (evy-enable-compiler-log-hel)
      (setq-local display-fill-column-indicator nil)
      (when (bound-and-true-p hel-local-mode)
        (hel-update-cursor)))))

(add-hook 'elpaca-after-init-hook #'evy-enable-editor-ui 95)

(provide 'evy-ui)
;;; evy-ui.el ends here
