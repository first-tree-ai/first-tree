export const VALIDATION_CODES = {
  frontmatterMissing: "TREE_FRONTMATTER_MISSING",
  frontmatterParse: "TREE_FRONTMATTER_PARSE",
  titleMissing: "TREE_TITLE_MISSING",
  titleInvalid: "TREE_TITLE_INVALID",
  ownersMissing: "TREE_OWNERS_MISSING",
  ownersInvalid: "TREE_OWNERS_INVALID",
  descriptionInvalid: "TREE_DESCRIPTION_INVALID",
  softLinksInvalid: "TREE_SOFT_LINKS_INVALID",
  softLinkBroken: "TREE_SOFT_LINK_BROKEN",
  softLinkPathEscape: "TREE_SOFT_LINK_PATH_ESCAPE",
  softLinkArchiveDependency: "TREE_SOFT_LINK_ARCHIVE_DEPENDENCY",
  markdownPathEscape: "TREE_MARKDOWN_LINK_PATH_ESCAPE",
  markdownArchiveDependency: "TREE_MARKDOWN_LINK_ARCHIVE_DEPENDENCY",
  markdownFileSymlinkBroken: "TREE_MARKDOWN_FILE_SYMLINK_BROKEN",
  markdownFileSymlinkUnsupported: "TREE_MARKDOWN_FILE_SYMLINK_UNSUPPORTED",
  markdownFilePathEscape: "TREE_MARKDOWN_FILE_PATH_ESCAPE",
  markdownFileContentClassMismatch: "TREE_MARKDOWN_FILE_CONTENT_CLASS_MISMATCH",
  directorySymlinkUnsupported: "TREE_DIRECTORY_SYMLINK_UNSUPPORTED",
  directorySymlinkPathEscape: "TREE_DIRECTORY_SYMLINK_PATH_ESCAPE",
  memberFrontmatterMissing: "TREE_MEMBER_FRONTMATTER_MISSING",
  memberFrontmatterParse: "TREE_MEMBER_FRONTMATTER_PARSE",
  memberTitleInvalid: "TREE_MEMBER_TITLE_INVALID",
  memberOwnersMissing: "TREE_MEMBER_OWNERS_MISSING",
  memberOwnersInvalid: "TREE_MEMBER_OWNERS_INVALID",
  memberTypeMissing: "TREE_MEMBER_TYPE_MISSING",
  memberTypeInvalid: "TREE_MEMBER_TYPE_INVALID",
  memberTypeShape: "TREE_MEMBER_TYPE_SHAPE",
  memberStatusInvalid: "TREE_MEMBER_STATUS_INVALID",
  memberStatusShape: "TREE_MEMBER_STATUS_SHAPE",
  memberRoleInvalid: "TREE_MEMBER_ROLE_INVALID",
  memberRoleShape: "TREE_MEMBER_ROLE_SHAPE",
  memberDomainsInvalid: "TREE_MEMBER_DOMAINS_INVALID",
  memberDomainsShape: "TREE_MEMBER_DOMAINS_SHAPE",
  membersDirectoryMissing: "TREE_MEMBERS_DIRECTORY_MISSING",
  memberNodeMissing: "TREE_MEMBER_NODE_MISSING",
  memberNodesEmpty: "TREE_MEMBER_NODES_EMPTY",
  evidenceFileParse: "TREE_EVIDENCE_FILE_PARSE",
  evidenceSourcesInvalid: "TREE_EVIDENCE_SOURCES_INVALID",
  evidenceRecordInvalid: "TREE_EVIDENCE_RECORD_INVALID",
  evidenceQuoteMissing: "TREE_EVIDENCE_QUOTE_MISSING",
  evidenceNodeMissing: "TREE_EVIDENCE_NODE_MISSING",
  evidenceDuplicateId: "TREE_EVIDENCE_DUPLICATE_ID",
  evidenceDanglingReference: "TREE_EVIDENCE_DANGLING_REFERENCE",
  evidenceContradiction: "TREE_EVIDENCE_CONTRADICTION",
} as const;

export type ValidationCode = (typeof VALIDATION_CODES)[keyof typeof VALIDATION_CODES];

export type TreeValidationFinding = {
  code: ValidationCode;
  message: string;
  path: string;
  target?: string;
};

export function formatValidationFinding(finding: TreeValidationFinding): string {
  const target = finding.target === undefined ? "" : ` (target: ${finding.target})`;
  return `[${finding.code}] ${finding.path}: ${finding.message}${target}`;
}
