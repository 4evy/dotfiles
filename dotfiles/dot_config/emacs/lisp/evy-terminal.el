;;; evy-terminal.el --- Terminal and client integration -*- lexical-binding: t -*-

;;; Commentary:

;; Connect terminal appearance, explicit clipboard copying, and ANSI scrollback
;; to the shared daemon.  These adapters use the client frame's session state.

;;; Code:

(require 'helheim-core)
(require 'subr-x)

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

;; Keep Helix's internal copy/paste separate from the system clipboard.
(setq select-enable-clipboard nil
      select-enable-primary nil)

(setup clipetty (:install t))

(defun evy-copy-to-clipboard ()
  "Copy explicitly using the GUI clipboard or the client's terminal."
  (interactive)
  (call-interactively (if (display-graphic-p)
                         #'clipboard-kill-ring-save
                       #'clipetty-kill-ring-save)))

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

;; Keep terminal colors when a piped command supplies ANSI SGR sequences.
(defun evy-render-ansi-colors ()
  "Decode ANSI output into editable, colored text.
Saving the buffer writes readable text without terminal escape sequences."
  (interactive)
  (require 'ansi-color)
  (require 'ansi-osc)
  (whitespace-mode -1)
  (font-lock-mode -1)
  (let ((inhibit-read-only t)
        (buffer-undo-list t)
        (modified (buffer-modified-p))
        (ansi-color-context-region nil)
        (ansi-color-apply-face-function
         (lambda (begin end face)
           (when face (put-text-property begin end 'face face)))))
    (ansi-osc-filter-region (point-min) (point-max))
    (ansi-color-apply-on-region (point-min) (point-max))
    (set-buffer-modified-p modified)))

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

(defun evy-client-buffer-directory ()
  "Use the client's working directory for scratch and incoming pipe buffers."
  ;; Emacsclient already sends its environment with each new frame.
  (when-let* ((directory (getenv "PWD" (selected-frame)))
              ((file-name-absolute-p directory))
              ((file-directory-p directory)))
    (with-current-buffer (window-buffer (selected-window))
      (when (or (not buffer-file-name)
                (frame-parameter nil 'evy-piped-buffer))
        (setq-local default-directory (file-name-as-directory directory))))))

(defun evy-client-scratch-directory ()
  "Initialize the displayed non-file buffer for a new client frame."
  (unless (frame-parameter nil 'evy-piped-buffer)
    (evy-client-buffer-directory)))

(add-hook 'server-after-make-frame-hook #'evy-client-scratch-directory)

(defun evy-client-render-ansi-colors ()
  "Render the initial buffer when a client requests ANSI scrollback."
  (when (frame-parameter nil 'evy-piped-buffer)
    (evy-client-buffer-directory)
    (set-frame-parameter nil 'evy-piped-buffer nil))
  (when (frame-parameter nil 'evy-render-ansi)
    (set-frame-parameter nil 'evy-render-ansi nil)
    (evy-render-ansi-colors)))

(add-hook 'server-switch-hook #'evy-client-render-ansi-colors)

(add-to-list 'auto-mode-alist (cons (rx ".ansi" string-end) 'text-mode))

(provide 'evy-terminal)
;;; evy-terminal.el ends here
