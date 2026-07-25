from workstation.chezmoi import COMMANDS, app
from workstation.chezmoi_shell import _completion_command
from workstation.local.gnome import _gtk_accent_css


def test_chezmoi_registry_has_one_visible_command_per_declaration() -> None:
    names = [name for name, _command in COMMANDS]

    assert len(names) == len(set(names))
    assert set(names) == {
        name
        for name, command in app.resolved_commands().items()
        if not name.startswith("-") and command.show is not False
    }


def test_shell_completion_commands_are_data_templates() -> None:
    assert _completion_command(("jj", "util", "completion", "{shell}"), "zsh") == (
        "jj",
        "util",
        "completion",
        "zsh",
    )


def test_gtk_accent_css_shares_common_definitions() -> None:
    gtk3 = _gtk_accent_css("#f4b8e4", gtk_version=3)
    gtk4 = _gtk_accent_css("#f4b8e4", gtk_version=4)

    for css in (gtk3, gtk4):
        assert css.count("@define-color accent_color #f4b8e4;") == 1
        assert css.count("@define-color accent_bg_color #f4b8e4;") == 1
        assert css.count("@define-color accent_fg_color") == 1
    assert "theme_selected_bg_color" in gtk3
    assert "--accent-bg-color" in gtk4
