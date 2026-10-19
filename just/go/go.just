import '../common.just'

set working-directory := '../..'
set default-list
# Let Go parse go.work, preserving module paths as individual Just arguments
go_modules() := nul_split(shell('go work edit -json | jq -jer ' + quote('.Use[].DiskPath + "\u0000"')))

# Discover modules from go.work so adding a module also adds its checks
[group('check')]
check: (_go-check go_modules())

_go-check modules: *(_go-format *modules)
    go test {{ quote(modules / '...') }}
    go vet {{ quote(modules / '...') }}
    golangci-lint run {{ quote(modules / '...') }}
    CGO_ENABLED=0 go build -o /dev/null ./packages/theme-run/cmd/theme-run

_go-format module:
    unformatted=$(find {{ quote(module) }} -type f -name '*.go' -exec gofmt -l {} +)
    if [[ -n $unformatted ]]; then
      printf 'Go files need formatting:\n%s\n' "$unformatted" >&2
      exit 1
    fi
