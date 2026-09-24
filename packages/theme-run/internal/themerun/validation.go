package themerun

import (
	"errors"
	"fmt"
	"maps"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	validation "github.com/go-ozzo/ozzo-validation/v4"
)

var (
	requiredStrings = []validation.Rule{validation.Required, validation.Each(validation.Required)}
	environmentName = validation.Match(regexp.MustCompile(`^[^=\x00]+$`)).Error("must not contain '=' or NUL")
	themeValue      = validation.In(Dark, Light)
)

func init() {
	validation.ErrorTag = "toml"
}

func (env Variables) Validate() error {
	for name := range env {
		if err := validation.Validate(name, validation.Required, environmentName); err != nil {
			return fmt.Errorf("environment name %q: %w", name, err)
		}
	}
	return nil
}

func (p Platform) Validate() error {
	return validation.ValidateStruct(&p,
		validation.Field(&p.Commands, validation.Each(requiredStrings...)),
		validation.Field(&p.Fallback, validation.Required, themeValue),
	)
}

func (r Runtime) Validate() error {
	if _, exists := r.ThemePlatforms[""]; exists {
		return errors.New("platform name must not be empty")
	}
	return validation.ValidateStruct(&r,
		validation.Field(&r.ThemeEnvironment, validation.Required),
		validation.Field(&r.ThemeAliases, validation.Required, validation.Map(
			validation.Key(Dark, requiredStrings...), validation.Key(Light, requiredStrings...),
		)),
		validation.Field(&r.ThemeTerminalProgramEnvironment, validation.Required),
		validation.Field(&r.ThemeTerminalQueries, validation.Required,
			validation.Map(validation.Key(terminalFallbackName)).AllowExtraKeys(),
			validation.Each(validation.Required, validation.In(TerminalProtocolBackground, TerminalProtocolColorScheme))),
		validation.Field(&r.ThemePlatforms, validation.Required,
			validation.Map(validation.Key(terminalFallbackName)).AllowExtraKeys()),
		validation.Field(&r.ThemeProbeTimeoutMS, validation.Required, validation.Min(1), validation.Max(60_000)),
		validation.Field(&r.HelperTimeoutMS, validation.Required, validation.Min(1), validation.Max(60_000)),
		validation.Field(&r.HelperOutputLimitBytes, validation.Required, validation.Min(1), validation.Max(maxFileBytes)),
	)
}

func (i Interpreter) Validate() error {
	return validation.ValidateStruct(&i,
		validation.Field(&i.Name, validation.Required),
		validation.Field(&i.ShebangCommands, requiredStrings...),
		validation.Field(&i.ShebangArguments, requiredStrings...),
		validation.Field(&i.Programs, requiredStrings...),
	)
}

func (r Runner) Validate() error {
	return validation.ValidateStruct(&r,
		validation.Field(&r.Name, validation.Required),
		validation.Field(&r.Aliases, validation.Each(validation.Required)),
		validation.Field(&r.Programs, validation.Each(validation.NotIn(environmentReference))),
		validation.Field(&r.SkipEnv, validation.Each(validation.Required, environmentName)),
		validation.Field(&r.EnvUnset, validation.Each(validation.Required, environmentName)),
		validation.Field(&r.Env),
	)
}

func (i Integration) Validate() error {
	config := i.Strategy == IntegrationStrategyConfig
	if err := validation.ValidateStruct(&i,
		validation.Field(&i.Name, validation.Required),
		validation.Field(&i.DarkTheme, validation.Required),
		validation.Field(&i.LightTheme, validation.Required),
		validation.Field(&i.Strategy, validation.Required, validation.In(
			IntegrationStrategyArguments, IntegrationStrategyConfig, IntegrationStrategyEnvironment)),
		validation.Field(&i.Env, validation.Required.When(i.Strategy == IntegrationStrategyEnvironment)),
		validation.Field(&i.DefaultConfig, validation.Required.When(config)),
		validation.Field(&i.Assignment, validation.Required.When(config)),
		validation.Field(&i.ConfigFlags, validation.Required.When(config)),
		validation.Field(&i.ConfigOutputFlag, validation.Required.When(config)),
		validation.Field(&i.TemporaryPrefix, validation.Required.When(config)),
		validation.Field(&i.TemporaryLocation, validation.When(config,
			validation.Required, validation.In(TemporaryLocationSystem, TemporaryLocationCache))),
		validation.Field(&i.CacheSubdirectory, validation.Required.When(config && i.TemporaryLocation == TemporaryLocationCache)),
		validation.Field(&i.Quote, validation.When(config, validation.Required, validation.In("'", "\""))),
		validation.Field(&i.Validation, validation.When(config, validation.In(ValidationTOML))),
	); err != nil {
		return err
	}
	switch i.Strategy {
	case IntegrationStrategyArguments:
		if !containsPlaceholder(i.Arguments, themePlaceholder) {
			return fmt.Errorf("argument strategy must use %s", themePlaceholder)
		}
		contextFields := []string{i.ContextTable, i.ContextField, i.ContextValue}
		usesContext := slices.ContainsFunc(contextFields, func(field string) bool { return field != "" })
		if usesContext && (hasEmpty(contextFields) || !containsPlaceholder(i.Arguments, contextPlaceholder)) {
			return errors.New("directory context policy is incomplete")
		}
		for _, command := range i.ContextDirectoryCommands {
			if !containsPlaceholder(command, directoryPlaceholder) {
				return fmt.Errorf("directory context command must use %s", directoryPlaceholder)
			}
		}
	case IntegrationStrategyConfig:
		if !strings.HasSuffix(i.TemporaryPrefix, temporarySuffix) || filepath.Base(i.TemporaryPrefix) != i.TemporaryPrefix {
			return fmt.Errorf("temporary prefix must be a basename ending in %s", temporarySuffix)
		}
	case IntegrationStrategyEnvironment:
		if !containsPlaceholder(slices.Collect(maps.Values(i.Env)), themePlaceholder) {
			return fmt.Errorf("environment strategy must use %s", themePlaceholder)
		}
	}
	return nil
}
