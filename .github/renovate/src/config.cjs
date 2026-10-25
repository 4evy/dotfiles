// We never want Renovate to create any PRs or issues under any circumstances
// Updates must only add commits on top of master, with no PR fallback on failure
// The pinned source patch blocks both platform creation APIs and keeps staging
// branches local; retain those guards when upgrading Renovate
// The no-PR result must retain Renovate's typed outcome, including blocked updates
module.exports = {
  allowedCommands: ["^bun scripts/renovate/artifacts\\.ts$"],
  onboarding: false,
  requireConfig: "required",
  force: {
    baseBranchPatterns: ["master"],
    branchPrefix: "renovate/",
    automerge: true,
    automergeType: "branch",
    platformCommit: "disabled",
    platformAutomerge: false,
    ignoreTests: true,
    // Staging commits stay local; artifact errors still block master updates
    statusCheckWhen: {
      artifactError: "never",
      minimumReleaseAge: "never",
      mergeConfidence: "never",
    },
    dependencyDashboard: false,
    dependencyDashboardApproval: false,
    configWarningReuseIssue: false,
    configMigration: false,
    vulnerabilityAlerts: { enabled: false },
    semanticCommits: "enabled",
    semanticCommitType: "deps",
  },
};
