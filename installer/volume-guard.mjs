// Keep a host's explicitly installed storage guard when refreshing launchd jobs.
// Never copy old executable arguments: wrap the newly rendered arguments.
export function preserveVolumeGuard(rendered, current) {
  if (!current?.includes('<key>VeneerOriginalProgramArguments</key>')) return rendered;
  const old = current.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  const prefix = old?.[1].match(/^\s*(<string>\/usr\/bin\/python3<\/string>\s*<string>[^<]+\/veneer-volume\/ensure-mounted\.py<\/string>\s*<string>--exec<\/string>)/);
  if (!prefix) throw new Error('Unrecognized external-volume guard; refusing to remove it');
  const args = rendered.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!args || rendered.includes('<key>VeneerOriginalProgramArguments</key>')) throw new Error('Cannot safely wrap launchd arguments');
  return rendered.replace(args[0], `<key>ProgramArguments</key><array>${prefix[1]}${args[1]}</array>\n<key>VeneerOriginalProgramArguments</key><array>${args[1]}</array>`);
}
