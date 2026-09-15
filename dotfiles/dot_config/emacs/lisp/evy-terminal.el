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

(provide 'evy-terminal)
;;; evy-terminal.el ends here
