// Ambient declarations for template files imported as text (`with { type: "text" }`).
// Bun inlines these as strings at build time; this teaches `tsc` their default-export type.
declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.sh" {
  const content: string;
  export default content;
}
