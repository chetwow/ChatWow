export type ReleaseNotesSection = {
  title: string;
  items: string[];
};

export type ReleaseNotes = {
  version: string;
  sections: ReleaseNotesSection[];
};

/**
 * Read one Keep a Changelog release. Continuation lines are folded back into
 * their bullet so the UI receives content rather than Markdown layout.
 */
export function parseReleaseNotes(markdown: string, version: string): ReleaseNotes | null {
  const sections: ReleaseNotesSection[] = [];
  let inRelease = false;
  let section: ReleaseNotesSection | null = null;
  let item = "";

  const finishItem = () => {
    if (section && item) section.items.push(item);
    item = "";
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const release = line.match(/^## \[([^\]]+)\](?:\s+-\s+.+)?$/);
    if (release) {
      if (inRelease) break;
      inRelease = release[1] === version;
      continue;
    }
    if (!inRelease) continue;

    const heading = line.match(/^###\s+(.+)$/);
    if (heading) {
      finishItem();
      section = { title: heading[1], items: [] };
      sections.push(section);
      continue;
    }
    if (!section) continue;

    if (line.startsWith("- ")) {
      finishItem();
      item = line.slice(2).trim();
    } else if (line && item) {
      item += ` ${line}`;
    }
  }
  finishItem();

  const populated = sections.filter((entry) => entry.items.length > 0);
  return populated.length > 0 ? { version, sections: populated } : null;
}
