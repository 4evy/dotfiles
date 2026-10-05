export const PATH = "/io/github/fourevy/OmpWorkspaces";
export const SOURCE_HASH = "@SOURCE_HASH@";
export const XML = `<node><interface name="io.github.fourevy.OmpWorkspaces1">
<method name="Inspect"><arg type="s" direction="out"/></method>
<method name="Launch"><arg type="s" direction="in"/><arg type="as" direction="in"/><arg type="a{ss}" direction="in"/><arg type="s" direction="in"/><arg type="ah" direction="in"/><arg type="u" direction="out"/></method>
<method name="Open"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{ss}" direction="in"/><arg type="u" direction="out"/></method>
<method name="Status"><arg type="s" direction="in"/><arg type="b" direction="out"/><arg type="b" direction="out"/><arg type="i" direction="out"/></method>
<method name="Busy"><arg type="u" direction="out"/></method>
<method name="Ready"><arg type="s" direction="in"/></method>
<method name="Release"><arg type="s" direction="in"/><arg type="b" direction="out"/></method>
</interface></node>`;

export type LaunchArguments = [
  string,
  string[],
  Record<string, string>,
  string,
  number[],
];
export type OpenArguments = [string, string, string, Record<string, string>];

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
