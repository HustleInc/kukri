#!/usr/bin/env node

const tmp = require('tmp');
const util = require('util');
const cp = require('child_process');
const yargs = require('yargs');
const logger = require('winston');
const inquirer = require('inquirer');
const semver = require('semver');
const Git = require('nodegit');
const GCH = require('git-credential-helper');

// Enable pretty CLI logging
logger.cli();

// Custom fill promisification because callback is not final argument
GCH.fill[util.promisify.custom] = function(url, options) {
  return new Promise((resolve, reject) => {
    GCH.fill(url, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    }, options);
  });
}

// Promisify apis that have cb style
const gchAvailable = util.promisify(GCH.available);
const gchFill = util.promisify(GCH.fill);

function wrap(fn) {
  return function(args) {
    fn(args).then(logger.info, logger.error);
  }
}

async function getCreds(remote) {
  const url = remote.url();
  const credentialHelperAvailable = await gchAvailable();

  if (url.startsWith('git')) {
    return null;
  }

  if (!credentialHelperAvailable) {
    throw new Error("Using https remote but git credentials helper not available!");
  }

  return gchFill(url, { silent: true });
}

function makeGitOpts(credentials) {
  const options = {
    callbacks: { certificateCheck: () => 1 }
  };

  if (credentials) {
    // If we have credentials, use them
    options.callbacks.credentials = (url, username) => {
      return Git.Cred.userpassPlaintextNew(credentials.username, credentials.password);
    }
  } else {
    // If we don't have credentials try to get an ssh key from the agent
    options.callbacks.credentials = (url, username) => {
      return Git.Cred.sshKeyFromAgent(username)
    }
  }
  return options;
}

// HACK: this depends on the project being a NodeJS project
// TODO: improve by allowing user to point you to file containing version info
function getVersion(repoPath) {
  if (!repoPath) {
    repoPath = process.cwd();
  }
  const pkg = require(`${repoPath}/package.json`);
  return pkg.version;
}

function generateNextVersion(currentVersion, level, preId) {
  const version = semver.inc(currentVersion, level, preId);
  const minorVer = `v${semver.major(version)}.${semver.minor(version)}`;
  const prerelease = semver.prerelease(version);
  let releaseBranchName = `release-${minorVer}`;

  if (prerelease !== null) {
    releaseBranchName += `-${prerelease[0]}`;
  }

  return { version, minorVer, releaseBranchName };
}

async function approveDiff(repo, currentVersion, nextVersion) {
  const walk = Git.Revwalk.create(repo);
  const endRange = nextVersion ? `v${nextVersion}` : 'master';
  const range = `v${currentVersion}..${endRange}`;
  walk.pushRange(range);
  const commits = await walk.getCommitsUntil(() => true);

  console.log(`--- START COMMIT LOG ${range} ---`);
  commits.forEach((commit) => {
    const sha = commit.sha();
    const msg = commit.message();
    const author = commit.author().name();
    const comitter = commit.committer().name();
    const date = commit.date();
    console.log(`[${date}] (${author}) ${msg}`);
  });
  console.log(`--- END COMMIT LOG ${range} ---`);

  return await inquirer.prompt([
    {
      type: 'confirm',
      name: 'lgtm',
      message: `Does the commit log look good?`,
      default: false,
    }
  ]);
}

async function cutReleaseBranch(args) {
  // Get upstream remote for current repo
  const repo = await Git.Repository.open('.');
  const remote = await repo.getRemote(args.upstream);
  const credentials = await getCreds(remote);
  const url = remote.url();

  // Create tempdir and clone fresh copy
  const tmpdir = tmp.dirSync({ unsafeCleanup: true });
  const options = { fetchOpts: makeGitOpts(credentials) }

  // Clone a fresh copy of the repository
  const clonedRepo = await Git.Clone(url, tmpdir.name, options);
  const clonedRemote = await clonedRepo.getRemote('origin');

  // Determine new version and branch names
  const currentVersion = getVersion(tmpdir.name);
  const versionInfo = generateNextVersion(currentVersion, args.level, args.preid);
  logger.info('Incrementing', currentVersion, 'to', versionInfo.version);

  // Ask for approval on diff before cutting
  logger.info('Cutting branch', versionInfo.releaseBranchName);
  const approval = await approveDiff(repo, currentVersion);

  // Shell out to run npm version inside tempdir
  cp.execSync(`npm version ${args.level} -m "Release v%s"`, { cwd: tmpdir.name });
  repo.refreshIndex();

  if (!approval.lgtm) {
    return 'Aborted branch cut! Phew, that was a close one...';
  }

  // Push master, the release branch, and tag
  logger.info(`Pushing branch ${versionInfo.releaseBranchName} & tag v${versionInfo.version}`);
  await clonedRemote.push([
    `refs/heads/master:refs/heads/master`,
    `refs/heads/master:refs/heads/${versionInfo.releaseBranchName}`,
    `refs/tags/v${versionInfo.version}:refs/tags/v${versionInfo.version}`,
  ], makeGitOpts(credentials));

  return 'Done!';
}

async function tagVersion(args) {
  // Get upstream remote for current repo
  const repo = await Git.Repository.open('.');
  const remote = await repo.getRemote(args.upstream);
  const credentials = await getCreds(remote);

  // Determine the next tag for this release branch (patch)
  const currentVersion = getVersion();
  const versionInfo = generateNextVersion(currentVersion, 'patch');

  // Shell out to run npm version
  cp.execSync('npm version patch -m "Release v%s"');

  // Ask for approval on diff before pushing
  logger.info('Tagging version', versionInfo.version);
  const approval = await approveDiff(repo, currentVersion, versionInfo.version);

  if (!approval.lgtm) {
    return 'Aborted push! Local changes not reverted, you must now do surgery!';
  }

  // Push updated release branch and new tag
  logger.info('Pushing tagged version', versionInfo.version);
  await remote.push([
    `refs/heads/${versionInfo.releaseBranchName}:refs/heads/${versionInfo.releaseBranchName}`,
    `refs/tags/v${versionInfo.version}:refs/tags/v${versionInfo.version}`,
  ], makeGitOpts(credentials));

  return 'Done!';
}

yargs
  .usage('git cactus <command>')
  .demandCommand(1, 'You need to provide a cactus command')
  .command('cut [level]', 'cuts a release branch from origin/master', (yargs) => {
    yargs
      .positional('level', {
        choices: ['major', 'minor', 'premajor', 'preminor', 'prerelease'],
        default: 'minor',
        describe: 'The level of the release'
      })
      .option('preid', {
        describe: 'Add preid to prereleases',
        type: 'string'
      });
  }, wrap(cutReleaseBranch))
  .command('tag', 'tags a version on a release branch', () => {}, wrap(tagVersion))
  .group(['upstream'], 'Git Options:')
  .option('upstream', { default: 'origin', describe: 'Upstream remote name'})
  .example('git cactus cut', 'Cuts a new release branch (minor)')
  .example('git cactus tag', 'Tags a new version (patch)')
  .argv
