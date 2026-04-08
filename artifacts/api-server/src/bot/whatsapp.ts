export interface WhatsAppSession {
  state: "collecting_links" | "waiting_name" | "waiting_exclusions";
  links: string[];
  baseName: string;
  baseNumber: number;
}

export function cleanWhatsAppLink(raw: string): string | null {
  const match = raw.match(/https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
  if (!match) return null;
  return `https://chat.whatsapp.com/${match[1]}`;
}

export function extractLinks(text: string): string[] {
  const regex = /https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9?=_&%-]+/g;
  const matches = text.match(regex) ?? [];
  return matches.map(cleanWhatsAppLink).filter((l): l is string => l !== null);
}

export function parseBaseName(input: string): { prefix: string; startNum: number } | null {
  const match = input.trim().match(/^([A-Za-z]+)(\d+)$/);
  if (!match) return null;
  return { prefix: match[1].toUpperCase(), startNum: parseInt(match[2], 10) };
}

export function buildOutput(
  links: string[],
  prefix: string,
  startNum: number,
  exclude: Set<string>
): string {
  const lines: string[] = [];
  let num = startNum;

  for (const link of links) {
    while (exclude.has(`${prefix}${num}`.toUpperCase())) {
      num++;
    }
    const name = `${prefix}${num}`;
    num++;
    lines.push(`${name}\n${link}`);
  }

  return lines.join("\n\n");
}
