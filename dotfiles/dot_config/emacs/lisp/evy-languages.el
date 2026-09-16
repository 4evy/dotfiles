;;; evy-languages.el --- Everyday language support -*- lexical-binding: t -*-

;;; Commentary:

;; Configure language modes, servers, and formatters for local files.

;;; Code:

(require 'cl-lib)
(require 'helheim-setup)
(require 'elpaca)
(eval-when-compile
  ;; Match init.el when Flymake compiles this module in a fresh process.
  (defvar helheim-package-manager 'elpaca))
(require 'eglot)
(require 'treesit)
(require 'editorconfig)
(require 'evy-performance)
(editorconfig-mode 1)

(setup go-mode (:install t))
(setup yaml-mode (:install t))
(setup lua-mode (:install t))
(setup nix-mode (:install t))
(setup dockerfile-mode (:install t))
(setup typescript-mode (:install t) (:require t))
(setup just-mode (:install t))
(setup swift-mode (:install t))
(setup zig-mode (:install t))
(setup rust-mode (:install t))
(setup ron-mode (:install t))
(autoload 'ron-mode "ron-mode" nil t)
(setup ssh-config-mode (:install t))
(setup web-mode (:install t))

(with-eval-after-load 'web-mode
  (add-to-list 'web-mode-content-types-alist '("jsx" . "\\.tsx\\'")))

(with-eval-after-load 'typescript-mode
  (add-to-list 'auto-mode-alist '("\\.tsx\\'" . tsx-ts-mode))
  (add-to-list 'auto-mode-alist '("\\.jsx\\'" . js-jsx-mode)))

;; Classic modes work without separately installed tree-sitter grammars.
(dolist (entry '(("\\.\\(?:mts\\|cts\\|ts\\)\\'" . typescript-mode)
                 ("\\.[mc]js\\'" . js-mode)
                 ("\\.jsonc\\'" . jsonc-mode)
                 ("/\\(?:Brewfile\\|Gemfile\\)\\(?:\\.lock\\)?\\'" . ruby-mode)
                 ("\\.\\(?:plist\\|tmTheme\\|svg\\)\\'" . nxml-mode)
                 ("\\.\\(?:service\\|timer\\|desktop\\|repo\\)\\'" . conf-unix-mode)
                 ("\\.kbd\\'" . lisp-data-mode)
                 ("\\.ron\\'" . ron-mode)
                 ("\\.hjson\\'" . js-mode)))
  (add-to-list 'auto-mode-alist entry))

;; Strip generator suffixes and run normal mode detection on the source name.
;; This also covers Python, Lisp, CSS and XML templates without separate rules.
(add-to-list 'auto-mode-alist '("\\.\\(?:tmpl\\|j2\\|in\\)\\'" nil t))

(dolist (entry
         `((,(rx ".just" eos) . just-mode)
           (,(rx "/" (or ".yamlfmt" ".yamllint" ".clang-format"
                         ".ansible-lint") eos) . yaml-mode)
           (,(rx "/" (or "uv.lock" "spectrum.lock") eos) . conf-toml-mode)
           (,(rx "/dot_" (or "bash" "zsh" "zprofile") (* nonl) eos) . sh-mode)
           (,(rx (or ".gitconfig" "/dot_gitconfig") eos) . conf-unix-mode)
           (,(rx "/private_config" eos) . ssh-config-mode)
           (,(rx (or ".theme" ".opts") eos) . conf-unix-mode)
           (,(rx "." (or "service" "timer" "path") eos) . conf-unix-mode)
           (,(rx ".glsl" eos) . glsl-mode)
           (,(rx "." (or "te" "if" "fc") eos) . conf-space-mode)
           (,(rx "." (or "rules" "apparmor") eos) . conf-space-mode)
           (,(rx "Brewfile.private" eos) . ruby-mode)
           (,(rx "/" (or "dot_gitignore_global" ".chezmoiignore"
                         ".dockerignore") eos) . conf-unix-mode)))
  (add-to-list 'auto-mode-alist entry))

(setup glsl-mode (:install t))

(defun evy-language-mode-fallbacks ()
  "Map language modes to installed tree-sitter grammars or classic modes."
  (dolist (entry '((c-mode c-ts-mode c)
                   (c++-mode c++-ts-mode cpp)
                   (sh-mode bash-ts-mode bash)
                   (lua-mode lua-ts-mode lua)
                   (json-mode json-ts-mode json)
                   (yaml-mode yaml-ts-mode yaml)
                   (typescript-mode typescript-ts-mode typescript)
                   (web-mode tsx-ts-mode (tsx typescript))))
    (let* ((classic (car entry))
           (tree-sitter (cadr entry))
           (grammar (nth 2 entry))
           (mode (if (and (fboundp tree-sitter)
                          (treesit-ready-p grammar t))
                     tree-sitter
                   classic)))
      ;; Only .tsx files use the TSX parser; other Web mode files keep it.
      (unless (eq classic 'web-mode)
        (setf (alist-get classic major-mode-remap-alist) mode))
      (setf (alist-get tree-sitter major-mode-remap-alist) mode))))

(add-hook 'elpaca-after-init-hook #'evy-language-mode-fallbacks 95)
(evy-language-mode-fallbacks)

(defun evy-template-buffer-p ()
  "Whether this buffer contains source that still needs template expansion."
  (and buffer-file-name
       (string-match-p "\\.\\(?:tmpl\\|j2\\|in\\)\\'" buffer-file-name)))

(dolist (entry
         '(((python-mode python-ts-mode) . ("ty" "server"))
           ((go-mode go-dot-mod-mode go-dot-work-mode
                     go-ts-mode go-mod-ts-mode go-work-ts-mode) . ("gopls"))
           ((sh-mode bash-ts-mode) . ("bash-language-server" "start"))
           (((js-jsx-mode :language-id "javascriptreact")
             (js-mode :language-id "javascript")
             (js-ts-mode :language-id "javascript")
             (typescript-mode :language-id "typescript")
             (typescript-ts-mode :language-id "typescript")
             (tsx-ts-mode :language-id "typescriptreact")
             (web-mode :language-id "typescriptreact"))
            . ("bunx" "--bun" "-p" "typescript-language-server"
               "typescript-language-server" "--stdio"))
           ((css-mode css-ts-mode)
            . ("bunx" "--bun" "-p" "vscode-langservers-extracted"
               "vscode-css-language-server" "--stdio"))
           ((html-mode mhtml-mode)
            . ("bunx" "--bun" "-p" "vscode-langservers-extracted"
               "vscode-html-language-server" "--stdio"))
           (((jsonc-mode :language-id "jsonc") json-mode json-ts-mode)
            . ("bunx" "--bun" "-p" "vscode-langservers-extracted"
               "vscode-json-language-server" "--stdio"))
           ((yaml-mode yaml-ts-mode) . ("yaml-language-server" "--stdio"))
           ((conf-toml-mode toml-ts-mode) . ("taplo" "lsp" "stdio"))
           ((nix-mode nix-ts-mode) . ("nil"))
           ((markdown-mode gfm-mode markdown-ts-mode) . ("rumdl" "server"))
           ((dockerfile-mode dockerfile-ts-mode)
            . ("bunx" "--bun" "-p" "dockerfile-language-server-nodejs"
               "docker-langserver" "--stdio"))
           ((lua-mode lua-ts-mode) . ("lua-language-server"))
           ((rust-mode rust-ts-mode) . ("rust-analyzer"))
           ((c-mode c-ts-mode c++-mode c++-ts-mode) . ("clangd"))
           ((ruby-mode ruby-ts-mode) . ("ruby-lsp"))
           ((swift-mode) . ("sourcekit-lsp"))
           ((zig-mode) . ("zls"))
           ((just-mode) . ("just-lsp"))))
  (add-to-list 'eglot-server-programs entry)
  (dolist (mode (car entry))
    (add-hook (intern (format "%s-hook" (if (consp mode) (car mode) mode)))
              #'evy-start-language-server)))

(defun evy-language-server-file-p ()
  "Whether this file should participate in automatic language support."
  (and buffer-file-name
       (not (file-remote-p buffer-file-name))
       (not (evy-template-buffer-p))
       (not (evy-long-line-buffer-p))
       (not (string-prefix-p (file-truename temporary-file-directory)
                             (file-truename buffer-file-name)))))

(defun evy-start-language-server ()
  "Ask Eglot to manage eligible files after the current command."
  (when (evy-language-server-file-p)
    (eglot-ensure)))

;; Use the mode hooks above instead of Helheim's additional starters.
;; `eglot-ensure' defers connection until after local variables are ready.
(defun evy-configure-lsp-hooks ()
  "Use the file-opening policy for Helheim's language modules too."
  (dolist (hook '(c-mode-hook c++-mode-hook
                              c-ts-mode-hook c++-ts-mode-hook
                              json-mode-local-vars-hook json-ts-mode-local-vars-hook
                              sh-base-mode-hook))
    (remove-hook hook #'helheim-lsp)))

(add-hook 'elpaca-after-init-hook #'evy-configure-lsp-hooks 95)
(evy-configure-lsp-hooks)

;; Eglot also discovers buffers when another file starts a project server.
;; It has no public buffer-exclusion hook: keep this one narrow guard so
;; templates and long-line output cannot join an already running server.
(advice-add 'eglot--maybe-activate-editing-mode :before-while
            #'evy-language-server-file-p)

(setup apheleia
  (:install t)
  (:require t)
  ;; Use the same shell and Markdown formatters as the previous Helix setup.
  (setf (alist-get 'shfmt apheleia-formatters)
        '("shfmt" "-i" "2" "-bn")
        (alist-get 'rumdl apheleia-formatters)
        '("rumdl" "fmt" "--stdin" "--stdin-filename" filepath))
  ;; Let project configuration control line lengths and indentation.
  (setq apheleia-formatters-respect-fill-column nil
        apheleia-formatters-respect-indent-level nil)
  ;; Use the installed Biome formatter without import or lint fixes.
  (setf (alist-get 'biome apheleia-formatters)
        '("biome" "format" "--stdin-file-path" filepath))
  ;; Keep upstream mode support and specify only our formatter preferences.
  (setf (alist-get 'sh-mode apheleia-mode-alist) 'shfmt)
  (dolist (mode '(json-mode jsonc-mode json-ts-mode js-mode js-ts-mode
                            js-jsx-mode typescript-mode typescript-ts-mode tsx-ts-mode
                            web-mode css-mode css-ts-mode))
    (setf (alist-get mode apheleia-mode-alist) 'biome))
  (dolist (mode '(markdown-mode gfm-mode markdown-ts-mode))
    (setf (alist-get mode apheleia-mode-alist) 'rumdl))
  (dolist (mode '(python-mode python-ts-mode))
    (setf (alist-get mode apheleia-mode-alist) 'ruff))
  (add-hook 'apheleia-inhibit-functions #'evy-template-buffer-p)
  (add-hook 'apheleia-inhibit-functions #'evy-long-line-buffer-p)
  (add-hook 'apheleia-skip-functions #'evy-template-buffer-p)
  (add-hook 'apheleia-skip-functions #'evy-long-line-buffer-p)
  (apheleia-global-mode 1))

(provide 'evy-languages)
;;; evy-languages.el ends here
