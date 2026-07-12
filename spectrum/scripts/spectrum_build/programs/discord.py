from spectrum_build.programs.models import DnfProgram

RPM_URL = "https://discord.com/api/download?platform=linux&format=rpm"

PROGRAM = DnfProgram(
    name="Discord",
    packages=(RPM_URL,),
    validation_packages=("discord",),
    nogpgcheck=True,
)
