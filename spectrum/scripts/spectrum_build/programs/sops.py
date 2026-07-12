from spectrum_build.integrations.github import ReleaseRpm
from spectrum_build.programs.models import DnfProgram
from spectrum_build.programs.sources import github_release_rpm

RELEASE = ReleaseRpm("SOPS", "getsops/sops", r"sops-[0-9].*-1\.{arch}\.rpm")

PROGRAM = DnfProgram(
    name=RELEASE.name,
    packages=github_release_rpm(RELEASE),
    validation_packages=("sops",),
)
