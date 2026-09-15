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
(declare-function web-mode "web-mode")
(declare-function web-mode-set-content-type "web-mode" (content-type))
(editorconfig-mode 1)

(setup go-mode (:install t))
(setup yaml-mode (:install t))
(setup toml-mode (:install t))
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

(define-derived-mode evy-tsx-mode web-mode "TSX"
  "Edit TypeScript with JSX using Web mode."
  (web-mode-set-content-type "jsx"))
(define-derived-mode evy-jsx-mode web-mode "JSX"
  "Edit JavaScript with JSX using Web mode."
  (web-mode-set-content-type "jsx"))

(defun evy-jsx-file-modes ()
  "Keep JSX associations ahead of TypeScript package defaults."
  (setq auto-mode-alist
        (delete (cons (rx ".tsx" eos) 'evy-tsx-mode) auto-mode-alist))
  (add-to-list 'auto-mode-alist (cons (rx ".tsx" eos) 'evy-tsx-mode))
  (add-to-list 'auto-mode-alist (cons (rx ".jsx" eos) 'evy-jsx-mode)))
(with-eval-after-load 'typescript-mode (evy-jsx-file-modes))
(add-hook 'elpaca-after-init-hook #'evy-jsx-file-modes 95)

(dolist (entry '((js-mode . "javascript") (js-ts-mode . "javascript")
                 (typescript-ts-mode . "typescript")
                 (tsx-ts-mode . "typescriptreact")
                 (evy-tsx-mode . "typescriptreact")
                 (evy-jsx-mode . "javascriptreact")
                 (jsonc-mode . "jsonc")))
  (put (car entry) 'eglot-language-id (cdr entry)))

;; Classic modes work without separately installed tree-sitter grammars.
(dolist (entry '(("\\.\\(?:mts\\|cts\\|ts\\)\\'" . typescript-mode)
                 ("\\.[jt]sx\\'" . web-mode)
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
           (,(rx "/" (or "uv.lock" "spectrum.lock") eos) . toml-mode)
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

(evy-jsx-file-modes)

(setup glsl-mode (:install t))

(defun evy-language-mode-fallbacks ()
  "Choose tree-sitter or classic modes when each buffer opens."
  (dolist (entry '((c-mode c-ts-mode c)
                   (c++-mode c++-ts-mode cpp)
                   (sh-mode bash-ts-mode bash)
                   (lua-mode lua-ts-mode lua)
                   (json-mode json-ts-mode json)
                   (yaml-mode yaml-ts-mode yaml)
                   (typescript-mode typescript-ts-mode typescript)
                   (evy-tsx-mode tsx-ts-mode (tsx typescript))))
    (let* ((classic (car entry))
           (tree-sitter (cadr entry))
           (grammar (nth 2 entry))
           (choose-mode
            (lambda ()
              (funcall (if (and (fboundp tree-sitter)
                                (treesit-ready-p grammar t))
                           tree-sitter
                         classic)))))
      (setf (alist-get classic major-mode-remap-alist) choose-mode
            (alist-get tree-sitter major-mode-remap-alist) choose-mode))))

(add-hook 'elpaca-after-init-hook #'evy-language-mode-fallbacks 95)
(evy-language-mode-fallbacks)

(defun evy-template-buffer-p ()
  "Whether this buffer contains source that still needs template expansion."
  (and buffer-file-name
       (string-match-p "\\.\\(?:tmpl\\|j2\\|in\\)\\'" buffer-file-name)))

(defconst evy-language-servers
  '(((python-mode python-ts-mode) . ("ty" "server"))
    ((go-mode go-ts-mode go-mod-ts-mode) . ("gopls"))
    ((sh-mode bash-ts-mode) . ("bash-language-server" "start"))
    ((js-mode js-ts-mode typescript-mode typescript-ts-mode tsx-ts-mode
              evy-tsx-mode evy-jsx-mode)
     . ("bunx" "--bun" "-p" "typescript-language-server"
        "typescript-language-server" "--stdio"))
    ((css-mode css-ts-mode)
     . ("bunx" "--bun" "-p" "vscode-langservers-extracted"
        "vscode-css-language-server" "--stdio"))
    ((html-mode mhtml-mode)
     . ("bunx" "--bun" "-p" "vscode-langservers-extracted"
        "vscode-html-language-server" "--stdio"))
    ((json-mode jsonc-mode json-ts-mode)
     . ("bunx" "--bun" "-p" "vscode-langservers-extracted"
        "vscode-json-language-server" "--stdio"))
    ((yaml-mode yaml-ts-mode) . ("yaml-language-server" "--stdio"))
    ((toml-mode toml-ts-mode) . ("taplo" "lsp" "stdio"))
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
    ((just-mode) . ("just-lsp")))
  "Language servers shared with the terminal development toolchain.")

(dolist (entry evy-language-servers)
  (add-to-list 'eglot-server-programs entry))

(defun evy-language-server-file-p ()
  "Whether this file should participate in automatic language support."
  (and buffer-file-name
       (not (file-remote-p buffer-file-name))
       (not (evy-template-buffer-p))
       (not (evy-long-line-buffer-p))
       (not (string-prefix-p (file-truename temporary-file-directory)
                             (file-truename buffer-file-name)))))

(defun evy-start-language-server ()
  "Start the configured server for local files when available."
  (when (evy-language-server-file-p)
    (when-let* ((entry (cl-find-if
                        (lambda (entry) (memq major-mode (car entry)))
                        evy-language-servers))
                (program (executable-find (cadr entry))))
      (eglot-ensure))))

(add-hook 'find-file-hook #'evy-start-language-server 95)

;; Helheim also starts servers from major-mode hooks. Use the same policy
;; there, including the executable check, instead of starting a second path.
(advice-add 'helheim-lsp :override #'evy-start-language-server)
;; Eglot also discovers buffers when another file starts a project server.
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
  ;; Respect project formatter settings instead of forcing fill-column = 80.
  (setf (alist-get 'ruff apheleia-formatters)
        '("ruff" "format" "--stdin-filename" filepath "-")
        (alist-get 'biome apheleia-formatters)
        '("biome" "format" "--stdin-file-path" filepath))
  (setq apheleia-mode-alist
        '((sh-mode . shfmt) (bash-ts-mode . shfmt)
          (go-mode . gofmt) (go-ts-mode . gofmt)
          (zig-mode . zig-fmt)
          (nix-mode . nixfmt) (nix-ts-mode . nixfmt)
          (toml-mode . taplo) (toml-ts-mode . taplo)
          (lua-mode . stylua) (lua-ts-mode . stylua)
          (rust-mode . rustfmt) (rust-ts-mode . rustfmt)
          (json-mode . biome) (jsonc-mode . biome) (json-ts-mode . biome)
          (js-mode . biome) (js-ts-mode . biome)
          (typescript-mode . biome) (typescript-ts-mode . biome)
          (tsx-ts-mode . biome)
          (evy-tsx-mode . biome) (evy-jsx-mode . biome)
          (css-mode . biome) (css-ts-mode . biome)
          (c-mode . clang-format) (c-ts-mode . clang-format)
          (c++-mode . clang-format) (c++-ts-mode . clang-format)))
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
