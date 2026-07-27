from workstation.local.desktop_audit import _lspci_display_devices


def test_lspci_display_devices_keeps_following_context() -> None:
    text = "\n".join((
        "00:00.0 Host bridge",
        "01:00.0 VGA compatible controller",
        "    Subsystem",
        "    Kernel driver in use: nvidia",
        "    Kernel modules: nouveau, nvidia",
        "02:00.0 Audio device",
        "03:00.0 Network controller",
    ))

    result = _lspci_display_devices(text)

    assert "VGA compatible controller" in result
    assert "Kernel driver in use: nvidia" in result
    assert "02:00.0 Audio device" in result
    assert "03:00.0 Network controller" not in result
