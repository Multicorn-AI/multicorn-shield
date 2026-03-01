#!/usr/bin/env node

import { execSync, spawnSync } from 'child_process';

const CONVENTIONAL_COMMIT_REGEX = /^(\w+)(!)?(?:\(([^)]+)\))?:\s*(.+)$/;

const EXCLUDED_TYPES = new Set(['chore', 'docs', 'test', 'ci']);

function getLastTag(currentTag) {
  try {
    const tags = execSync('git tag --sort=-version:refname', { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter(Boolean);

    if (tags.length === 0) {
      return null;
    }

    const previousTag = tags.find((tag) => tag !== currentTag) || null;
    return previousTag;
  } catch (error) {
    return null;
  }
}

function getCommitsSinceTag(tag) {
  try {
    const range = tag ? `${tag}..HEAD` : 'HEAD';
    const result = spawnSync(
      'git',
      ['log', '--format=%H|%s|%b', range],
      { encoding: 'utf-8' }
    );

    if (result.error) {
      console.error('Error getting commits:', result.error.message);
      return [];
    }

    if (result.status !== 0) {
      console.error('Error getting commits: git log failed');
      return [];
    }

    const lines = result.stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0);

    const commits = [];
    let currentCommit = null;

    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length >= 3) {
        if (currentCommit) {
          commits.push(currentCommit);
        }
        const [hash, subject, ...bodyParts] = parts;
        const bodyStart = bodyParts.join('|').trim();
        currentCommit = {
          hash: hash.trim(),
          subject: subject.trim(),
          body: bodyStart,
        };
      } else if (currentCommit) {
        currentCommit.body += '\n' + line.trim();
      }
    }

    if (currentCommit) {
      commits.push(currentCommit);
    }

    return commits;
  } catch (error) {
    console.error('Error getting commits:', error.message);
    return [];
  }
}

function parseCommit(commit) {
  if (!commit || !commit.subject || commit.subject.trim().length === 0) {
    return null;
  }

  const match = commit.subject.match(CONVENTIONAL_COMMIT_REGEX);
  if (!match) {
    return null;
  }

  const [, type, breaking, scope, description] = match;
  const isBreaking = Boolean(breaking);

  return {
    type: type.toLowerCase(),
    scope: scope || null,
    description: description.trim(),
    body: commit.body || '',
    isBreaking,
  };
}

function categorizeCommit(parsed) {
  if (!parsed) {
    return null;
  }

  const { type, description, isBreaking } = parsed;

  if (isBreaking) {
    return {
      category: 'changed',
      message: `BREAKING: ${description}`,
    };
  }

  if (EXCLUDED_TYPES.has(type)) {
    return null;
  }

  switch (type) {
    case 'feat':
      return { category: 'added', message: description };
    case 'fix':
      return { category: 'fixed', message: description };
    case 'security':
      return { category: 'security', message: description };
    default:
      return null;
  }
}

function generateChangelog(currentTag) {
  const version = currentTag.replace(/^v/, '');
  const date = new Date().toISOString().split('T')[0];

  const lastTag = getLastTag(currentTag);
  const commits = getCommitsSinceTag(lastTag);

  const categorized = commits
    .map(parseCommit)
    .map(categorizeCommit)
    .filter(Boolean);

  const grouped = {
    added: [],
    changed: [],
    fixed: [],
    security: [],
  };

  categorized.forEach(({ category, message }) => {
    if (grouped[category]) {
      grouped[category].push(message);
    }
  });

  const hasChanges = Object.values(grouped).some((arr) => arr.length > 0);

  if (!hasChanges) {
    return {
      version,
      date,
      changed: ['No user-facing changes in this release.'],
    };
  }

  const release = {
    version,
    date,
  };

  if (grouped.added.length > 0) {
    release.added = grouped.added;
  }
  if (grouped.changed.length > 0) {
    release.changed = grouped.changed;
  }
  if (grouped.fixed.length > 0) {
    release.fixed = grouped.fixed;
  }
  if (grouped.security.length > 0) {
    release.security = grouped.security;
  }

  return release;
}

function formatMarkdown(release) {
  const sections = [];

  if (release.added && release.added.length > 0) {
    sections.push('### Added');
    release.added.forEach((item) => sections.push(`- ${item}`));
  }

  if (release.changed && release.changed.length > 0) {
    sections.push('### Changed');
    release.changed.forEach((item) => sections.push(`- ${item}`));
  }

  if (release.fixed && release.fixed.length > 0) {
    sections.push('### Fixed');
    release.fixed.forEach((item) => sections.push(`- ${item}`));
  }

  if (release.security && release.security.length > 0) {
    sections.push('### Security');
    release.security.forEach((item) => sections.push(`- ${item}`));
  }

  return sections.join('\n\n');
}

const command = process.argv[2];
let currentTag = process.argv[3];

if (!currentTag) {
  const githubRef = process.env.GITHUB_REF;
  if (githubRef && githubRef.startsWith('refs/tags/')) {
    currentTag = githubRef.replace('refs/tags/', '');
  } else {
    console.error('Error: Tag must be provided as argument or via GITHUB_REF environment variable');
    process.exit(1);
  }
}

if (!currentTag.startsWith('v')) {
  console.error('Error: Tag must start with "v" (e.g., v0.2.0)');
  process.exit(1);
}

const release = generateChangelog(currentTag);

if (command === 'json') {
  console.log(JSON.stringify(release, null, 2));
} else if (command === 'markdown') {
  console.log(formatMarkdown(release));
} else {
  console.error('Usage: generate-changelog.mjs [json|markdown] [tag]');
  console.error('  json     - Output changelog as JSON');
  console.error('  markdown - Output changelog as Markdown');
  process.exit(1);
}
