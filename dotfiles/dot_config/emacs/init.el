;;; init.el --- Helheim configuration -*- lexical-binding: t; no-byte-compile: t -*-

;;; Commentary:

;; Configure Helheim, editor commands, and shared UI and language support.

;;; Code:

(when (display-graphic-p)
  (set-face-attribute 'default nil :family "JetBrainsMono Nerd Font" :height 140)
  (set-face-attribute 'fixed-pitch nil :family "JetBrainsMono Nerd Font")
  (set-fontset-font t 'unicode "JetBrainsMono Nerd Font" nil 'prepend)
  (set-fontset-font t #x2000 "Helvetica"))

(setq helheim-package-manager 'elpaca
      hel-want-fine-undo nil
      hel-reactivate-selection-after-insert-state t)
(require 'helheim-core)

;; Helheim redirects user-emacs-directory to its runtime directory.
;; Resolve our modules relative to this init file instead.
(add-to-list 'load-path
             (expand-file-name "lisp"
                               (file-name-directory
                                (or load-file-name user-init-file))))
(require 'evy-performance)

(require 'helheim-minibuffer)
(require 'helheim-completion)
(require 'helheim-search)
(require 'helheim-keybindings)
(require 'helheim-ibuffer)
(require 'helheim-dired)
(require 'helheim-embark)
(require 'helheim-outline)
(require 'helheim-xref)
(require 'helheim-snippets)
;; Helheim uses nil to hide the Flymake lighter, whose option type is string.
;; Normalize that assignment only while loading its Eglot configuration.
(let ((normalize-lighter
       (lambda (arguments)
         (if (equal arguments '(flymake-mode-line-lighter nil))
             '(flymake-mode-line-lighter "")
           arguments))))
  (advice-add 'setopt--set :filter-args normalize-lighter)
  (unwind-protect
      (require 'helheim-eglot)
    (advice-remove 'setopt--set normalize-lighter)))
(require 'helheim-magit)
(require 'helheim-diff-hl)
;; Helheim reads this before Org itself has loaded.
(setq org-modules '(ol-bibtex ol-docview ol-info))
(require 'helheim-org)
(require 'helheim-cpp)
(require 'helheim-emacs-lisp)
(require 'helheim-json)
(require 'helheim-markdown)
(require 'helheim-lua)
(require 'helheim-sh)

;; Forward terminal clicks, dragging, and scrolling to Emacs.
(xterm-mouse-mode 1)

;; Browse from this buffer's directory; keep project search explicit.
(hel-keymap-set mode-specific-map
  "f f" #'find-file
  "p f" #'project-find-file)

(setq display-line-numbers-type 'relative)
(add-hook 'prog-mode-hook #'display-line-numbers-mode)

;; Client frames close without shutting down the shared daemon.
(defun evy-quit ()
  "Close this client without saving, or exit a standalone Emacs."
  (interactive)
  (if (frame-parameter nil 'client)
      (delete-frame)
    (kill-emacs)))

(defun evy-save-and-quit ()
  "Save modified client files and close this terminal."
  (interactive)
  (save-buffers-kill-terminal t))

(hel-keymap-global-set :state 'normal
  "Z Q" #'evy-quit
  "Z W" #'evy-save-and-quit)

(setup majutsu
  (:install majutsu :host github :repo "0WD0/majutsu"))

(hel-keymap-set mode-specific-map
  "v j" #'majutsu
  "v b" #'magit-blame-addition
  "v l" #'magit-log-buffer-file)

;; Helheim's queued Consult configuration otherwise replaces ge.
(defun evy-helix-navigation ()
  "Restore Helix navigation after Helheim's package configuration."
  (hel-keymap-global-set :state 'normal
    "g e" #'hel-end-of-buffer))

(add-hook 'elpaca-after-init-hook #'evy-helix-navigation 90)

;; ESC returns to one cursor, as in Helix, before Hel's other ESC layers.
(defun evy-hel-escape ()
  "Collapse multiple cursors to one; otherwise run Hel's ESC behavior."
  (interactive)
  (if (bound-and-true-p hel-multiple-cursors-mode)
      (hel-disable-multiple-cursors-mode)
    (call-interactively #'hel-normal-state-escape)))
;; Run once for the main cursor, so Hel does not prompt about fake cursors.
(put 'evy-hel-escape 'multiple-cursors nil)

(hel-keymap-global-set :state 'normal
  "<escape>" #'evy-hel-escape)

;; Show changes in the terminal margin, including edits not yet saved.
(with-eval-after-load 'diff-hl
  (require 'diff-hl-margin)
  (require 'diff-hl-flydiff)
  (diff-hl-margin-mode 1)
  (setq diff-hl-flydiff-delay 0.3)
  (diff-hl-flydiff-mode 1)
  (hel-keymap-set diff-hl-mode-map :state 'normal
    "] g" #'diff-hl-next-hunk
    "[ g" #'diff-hl-previous-hunk))

;; Teach Emacs' change indicators about Jujutsu, including non-colocated repos.
(setup vc-jj
  (:install t)
  (:require t))

(menu-bar-mode -1)

;; Match Helix's visible whitespace without changing file contents.
(require 'whitespace)
(setq whitespace-style '(face tabs space-mark tab-mark)
      whitespace-display-mappings
      '((space-mark 160 [9085] [95])
        (tab-mark 9 [8594 9] [62 9])))
(setq-default truncate-lines t
              word-wrap nil)

(defun evy-editor-whitespace-and-lines ()
  "Show whitespace and keep source and prose lines unwrapped."
  (when (and (derived-mode-p 'prog-mode 'text-mode)
             (not (evy-long-line-buffer-p)))
    (when (bound-and-true-p +wrap-line-mode)
      (+wrap-line-mode -1))
    (when (bound-and-true-p visual-fill-column-mode)
      (visual-fill-column-mode -1))
    (visual-line-mode -1)
    (auto-fill-mode -1)
    (setq-local truncate-lines t
                word-wrap nil)
    (whitespace-mode 1)))

(add-hook 'after-change-major-mode-hook
          #'evy-editor-whitespace-and-lines 90)

(require 'evy-ui)
(require 'evy-languages)
(require 'evy-terminal)

(provide 'init)
;;; init.el ends here
