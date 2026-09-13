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

(add-to-list 'custom-theme-load-path
             (expand-file-name "~/.config/emacs-themes/"))
(defun evy-apply-terminal-theme (appearance)
  "Select the shared Emacs theme for terminal APPEARANCE."
  (let ((theme (if (eq appearance 'light) 't3-chat-light 't3-chat-dark)))
    (unless (memq theme custom-enabled-themes)
      (mapc #'disable-theme custom-enabled-themes)
      (load-theme theme t))))

(evy-apply-terminal-theme
 (if (equal (getenv "TERMINAL_THEME") "light") 'light 'dark))

(defun evy-client-terminal-theme ()
  "Follow the latest terminal client's requested appearance."
  (when-let* ((appearance (frame-parameter nil 'evy-terminal-theme)))
    (evy-apply-terminal-theme appearance)))

(add-hook 'server-after-make-frame-hook #'evy-client-terminal-theme)

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

;; Search nested project paths instead of completing one directory at a time.
;; Outside a project, prompt for one instead of searching temporary files.
(hel-keymap-set mode-specific-map
  "f f" #'project-find-file)

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

;; Keep Helix's internal copy/paste separate from the system clipboard.
(setq select-enable-clipboard nil
      select-enable-primary nil)

(defun evy-copy-to-clipboard ()
  "Copy the active selection to the system clipboard."
  (interactive)
  (unless (use-region-p)
    (user-error "Select text first"))
  (let* ((text (filter-buffer-substring (region-beginning) (region-end)))
         ;; A daemon may have started in a different desktop or SSH session.
         (process-environment (or (frame-parameter nil 'environment)
                                  process-environment))
         (command
          (cond
           ((eq system-type 'darwin) '("pbcopy"))
           ((and (getenv "WAYLAND_DISPLAY") (executable-find "wl-copy"))
            '("wl-copy" "--type" "text/plain;charset=utf-8"))
           ((and (getenv "DISPLAY") (executable-find "xclip"))
            '("xclip" "-selection" "clipboard" "-in")))))
    (cond
     (command
      (with-temp-buffer
        (insert text)
        (unless (zerop (apply #'call-process-region
                             (point-min) (point-max) (car command)
                             nil nil nil (cdr command)))
          (user-error "Clipboard copy failed"))))
     ((or (display-graphic-p)
          (terminal-parameter nil 'xterm--set-selection))
      (gui-set-selection 'CLIPBOARD text))
     (t (user-error "No clipboard available in this session"))))
  (message "Copied to system clipboard"))

(defvar evy-clipboard-map
  (let ((map (make-sparse-keymap)))
    (keymap-set map "y" #'evy-copy-to-clipboard)
    (keymap-set map "Y" #'evy-copy-to-clipboard)
    map)
  "System clipboard commands after leader Space or Ctrl/Cmd+Space.")

(hel-keymap-set mode-specific-map
  "SPC" evy-clipboard-map)

(hel-keymap-global-set :state 'normal
  ;; Helheim translates Space Space to C-c C-c.
  "C-c C-c" evy-clipboard-map
  "C-SPC" evy-clipboard-map
  "C-@" evy-clipboard-map
  "s-SPC" evy-clipboard-map
  "C-y" #'hel-copy
  "s-y" #'hel-copy)

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
  (when (derived-mode-p 'prog-mode 'text-mode)
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

(let ((directory (file-name-directory (or load-file-name user-init-file))))
  (load (expand-file-name "evy-ui.el" directory) nil t)
  (load (expand-file-name "evy-languages.el" directory) nil t))

;; Keep terminal colors when a piped command supplies ANSI SGR sequences.
(defun evy-render-ansi-colors ()
  "Display ANSI colors in this buffer without changing its saved contents."
  (interactive)
  (require 'ansi-color)
  (whitespace-mode -1)
  (font-lock-mode -1)
  (let ((inhibit-read-only t)
        (buffer-undo-list t)
        (existing-overlays (overlays-in (point-min) (point-max)))
        (modified (buffer-modified-p)))
    (unwind-protect
        (progn
          (setq-local ansi-color-context-region nil)
          ;; VT exports also contain OSC default colors and hyperlinks.
          ;; Hide these as data; never send terminal commands back to Ghostty.
          (save-excursion
            (goto-char (point-min))
            (while (re-search-forward
                    (rx "\e]" (* (not (any "\e\a")))
                        (or "\a" "\e\\")) nil t)
              (overlay-put (make-overlay (match-beginning 0) (match-end 0))
                           'invisible t)))
          (ansi-color-apply-on-region (point-min) (point-max) t)
          ;; Undo restores text properties, but not deleted overlays.
          ;; Convert only our rendering overlays so colors and hidden codes
          ;; travel with the text through deletion, undo, and yank.
          (dolist (overlay (overlays-in (point-min) (point-max)))
            (unless (memq overlay existing-overlays)
              (let ((start (overlay-start overlay))
                    (end (overlay-end overlay)))
                (dolist (property '(face invisible))
                  (when-let* ((value (overlay-get overlay property)))
                    (put-text-property start end property value)))
                (put-text-property start end 'rear-nonsticky
                                   '(face invisible)))
              (delete-overlay overlay))))
      (set-buffer-modified-p modified))))

(defun evy-render-piped-colors ()
  "Render colored output opened by the emacs-tui pipe launcher."
  (when (and buffer-file-name
             (or (string-prefix-p "emacs-stdin."
                                  (file-name-nondirectory buffer-file-name))
                 (string-suffix-p ".ansi" buffer-file-name))
             (save-excursion
               (goto-char (point-min))
               (search-forward "\e[" nil t)))
    (evy-render-ansi-colors)))

(add-hook 'find-file-hook #'evy-render-piped-colors 95)

(defun evy-client-render-ansi-colors ()
  "Render the initial buffer when a client requests ANSI scrollback."
  (when (frame-parameter nil 'evy-render-ansi)
    (set-frame-parameter nil 'evy-render-ansi nil)
    (evy-render-ansi-colors)))

(add-hook 'server-switch-hook #'evy-client-render-ansi-colors)

(add-to-list 'auto-mode-alist (cons (rx ".ansi" string-end) 'text-mode))

(provide 'init)
;;; init.el ends here
