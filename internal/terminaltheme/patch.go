package terminaltheme

import (
	"bytes"
	"strconv"
	"strings"

	kdl "github.com/sblinch/kdl-go"
	"github.com/sblinch/kdl-go/document"
	"gopkg.in/ini.v1"
)

func patchINI(configText string, updates []configUpdateSpec, themes ...Theme) (string, error) {
	theme := currentTheme(themes)
	cfg, err := ini.LoadSources(ini.LoadOptions{
		AllowBooleanKeys:        true,
		Insensitive:             false,
		InsensitiveSections:     false,
		InsensitiveKeys:         false,
		PreserveSurroundedQuote: true,
		SkipUnrecognizableLines: true,
		UnparseableSections:     nil,
		IgnoreInlineComment:     true,
	}, []byte(configText))
	if err != nil {
		return "", err
	}
	section := cfg.Section(ini.DefaultSection)
	for _, update := range updates {
		value := update.Dark
		if theme.Name == Latte.Name {
			value = update.Light
		}
		if update.Quote {
			value = strconv.Quote(value)
		}
		section.Key(update.Path).SetValue(value)
	}
	var out bytes.Buffer
	if _, err := cfg.WriteTo(&out); err != nil {
		return "", err
	}
	return out.String(), nil
}

func patchKDL(configText string, updates []configUpdateSpec, themes ...Theme) (string, error) {
	theme := currentTheme(themes)
	doc, err := kdl.Parse(strings.NewReader(configText))
	if err != nil {
		if strings.TrimSpace(configText) != "" {
			return "", err
		}
		doc = document.New()
	}
	for _, update := range updates {
		value := update.Dark
		if theme.Name == Latte.Name {
			value = update.Light
		}
		found := false
		for _, node := range doc.Nodes {
			if node.Name != nil && node.Name.ValueString() == update.Path {
				node.Arguments = []*document.Value{{Value: value, Flag: document.FlagQuoted}}
				found = true
				break
			}
		}
		if !found {
			node := document.NewNode()
			node.SetName(update.Path)
			node.AddArgument(value, "")
			if len(node.Arguments) > 0 {
				node.Arguments[0].Flag = document.FlagQuoted
			}
			doc.AddNode(node)
		}
	}
	var out bytes.Buffer
	if err := kdl.Generate(doc, &out); err != nil {
		return "", err
	}
	return out.String(), nil
}

func currentTheme(themes []Theme) Theme {
	if len(themes) > 0 && themes[0].Name != "" {
		return themes[0]
	}
	return DetectSystemTheme()
}

func setNestedValue(doc map[string]any, path []string, value any) {
	if len(path) == 1 {
		doc[path[0]] = value
		return
	}
	table := ensureTable(doc, path[0])
	setNestedValue(table, path[1:], value)
}

func ensureTable(doc map[string]any, key string) map[string]any {
	if table, ok := doc[key].(map[string]any); ok {
		return table
	}
	table := map[string]any{}
	doc[key] = table
	return table
}
