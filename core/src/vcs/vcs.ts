/*
 * Copyright (C) 2018-2024 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { sortBy, pick } from "lodash-es"
import { createHash } from "node:crypto"
import { relative, sep } from "path"
import fsExtra from "fs-extra"
import { dirname } from "node:path"

const { writeFile } = fsExtra
import type { ExternalSourceType } from "../util/ext-source-util.js"
import { getRemoteSourceLocalPath, getRemoteSourcesPath } from "../util/ext-source-util.js"
import type { ModuleConfig } from "../config/module.js"
import { serializeConfig } from "../config/module.js"
import type { Log } from "../logger/log-entry.js"
import { dedent, splitLast } from "../util/string.js"
import { fixedProjectExcludes } from "../util/fs.js"
import type { TreeCache } from "../cache.js"
import { pathToCacheContext } from "../cache.js"
import type { ServiceConfig } from "../config/service.js"
import type { TaskConfig } from "../config/task.js"
import type { TestConfig } from "../config/test.js"
import type { ActionKind } from "../plugin/action-types.js"
import type { GardenModule } from "../types/module.js"
import { validateInstall } from "../util/validateInstall.js"
import { isActionConfig, getSourceAbsPath } from "../actions/base.js"
import type { BaseActionConfig } from "../actions/types.js"
import type { Garden } from "../garden.js"
import { Profile } from "../util/profiling.js"

import AsyncLock from "async-lock"
import { makeDocsLinkStyled } from "../docs/common.js"

const scanLock = new AsyncLock()

export const versionStringPrefix = "v-"
export const NEW_RESOURCE_VERSION = "0000000000"
const fileCountWarningThreshold = 10000

const minGitVersion = "2.14.0"
export const gitVersionRegex = /git\s+version\s+v?(\d+.\d+.\d+)/

/**
 * throws if no git is installed or version is too old
 */
export async function validateGitInstall() {
  await validateInstall({
    minVersion: minGitVersion,
    name: "git",
    versionCommand: { cmd: "git", args: ["--version"] },
    versionRegex: gitVersionRegex,
  })
}

export interface TreeVersion {
  contentHash: string
  /**
   * Important! Do not use the files to determine if a file will exist when performing an action.
   * Other mechanisms, e.g. the build command itself and `copyFrom` might affect available files at runtime.
   *
   * See also https://github.com/garden-io/garden/issues/5201
   */
  files: string[]
}

export interface TreeVersions {
  [moduleName: string]: TreeVersion
}

// TODO: rename, maybe to ResourceVersion
export interface ModuleVersion extends TreeVersion {
  versionString: string
  dependencyVersions: DependencyVersions
}

export interface ActionVersion {
  versionString: string
  dependencyVersions: DependencyVersions
  configVersion: string
  sourceVersion: string
  files: string[]
}

export interface NamedModuleVersion extends ModuleVersion {
  name: string
}

export interface DependencyVersions {
  [key: string]: string
}

export interface NamedTreeVersion extends TreeVersion {
  name: string
}

export interface VcsInfo {
  branch: string
  commitHash: string
  originUrl: string
}

export type ActionDescription = `${ActionKind} action ${string}`
export type ActionRoot = `${ActionDescription} root`

export type ModuleDescription = `module ${string}`
export type ModuleRoot = `${ModuleDescription} root`

export type RepoPathDescription = "directory" | "repository" | "submodule" | "project root" | ActionRoot | ModuleRoot

export interface GetFilesParams {
  log: Log
  path: string
  pathDescription?: RepoPathDescription
  include?: string[]
  exclude?: string[]
  filter?: (path: string) => boolean
  failOnPrompt?: boolean
  scanRoot: string | undefined
}

export interface BaseIncludeExcludeFiles {
  include?: string[]
  exclude: string[]
}

export type IncludeExcludeFilesHandler<T extends GetFilesParams, R extends BaseIncludeExcludeFiles> = (
  params: T
) => Promise<R>

export interface GetTreeVersionParams {
  log: Log
  projectName: string
  config: ModuleConfig | BaseActionConfig
  scanRoot?: string // Set the scanning root instead of detecting, in order to optimize the scanning.
}

export interface RemoteSourceParams {
  url: string
  name: string
  sourceType: ExternalSourceType
  log: Log
  failOnPrompt?: boolean
}

export interface VcsFile {
  path: string
  hash: string
}

export interface VcsHandlerParams {
  garden?: Garden
  projectRoot: string
  gardenDirPath: string
  ignoreFile: string
  cache: TreeCache
}

@Profile()
export abstract class VcsHandler {
  protected garden?: Garden
  protected projectRoot: string
  protected gardenDirPath: string
  protected ignoreFile: string
  protected cache: TreeCache

  constructor(params: VcsHandlerParams) {
    this.garden = params.garden
    this.projectRoot = params.projectRoot
    this.gardenDirPath = params.gardenDirPath
    this.ignoreFile = params.ignoreFile
    this.cache = params.cache
  }

  abstract name: string

  abstract getRepoRoot(log: Log, path: string): Promise<string>

  /**
   * Scans the repository returns the list of the tracked files.
   * Applies Garden's exclude/include filters and .dotignore files.
   *
   * Does NOT sort the results by paths and filenames.
   */
  abstract getFiles(params: GetFilesParams): Promise<VcsFile[]>

  abstract ensureRemoteSource(params: RemoteSourceParams): Promise<string>

  abstract updateRemoteSource(params: RemoteSourceParams): Promise<void>

  abstract getPathInfo(log: Log, path: string): Promise<VcsInfo>

  clearTreeCache() {
    this.cache.clear()
  }

  async getTreeVersion({
    log,
    projectName,
    config,
    force = false,
    scanRoot,
  }: {
    log: Log
    projectName: string
    config: ModuleConfig | BaseActionConfig
    force?: boolean
    scanRoot?: string
  }): Promise<TreeVersion> {
    const cacheKey = getResourceTreeCacheKey(config)
    const description = describeConfig(config)

    // Note: duplicating this as an optimization (avoid the async lock)
    if (!force) {
      const cached = this.cache.get(log, cacheKey)
      if (cached) {
        log.silly(() => `Got cached tree version for ${description} (key ${cacheKey})`)
        return cached
      }
    }

    const configPath = getConfigFilePath(config)
    const path = getSourcePath(config)

    let result: TreeVersion = { contentHash: NEW_RESOURCE_VERSION, files: [] }

    // Make sure we don't concurrently scan the exact same context
    await scanLock.acquire(cacheKey.join(":"), async () => {
      if (!force) {
        const cached = this.cache.get(log, cacheKey)
        if (cached) {
          log.silly(() => `Got cached tree version for ${description} (key ${cacheKey})`)
          result = cached
          return
        }
      }

      // Apply project root excludes if the module config is in the project root and `include` isn't set
      const exclude =
        path === this.projectRoot && !config.include
          ? [...(config.exclude || []), ...fixedProjectExcludes]
          : config.exclude

      // No need to scan for files if nothing should be included
      if (!(config.include && config.include.length === 0)) {
        let files = await this.getFiles({
          log,
          path,
          pathDescription: `${description} root`,
          include: config.include,
          exclude,
          scanRoot,
        })

        if (files.length > fileCountWarningThreshold) {
          // TODO-0.13.0: This will be repeated for modules and actions resulting from module conversion
          await this.garden?.emitWarning({
            key: `${projectName}-filecount-${config.name}`,
            log,
            message: dedent`
              Large number of files (${
                files.length
              }) found in ${description}. You may need to configure file exclusions.
              See ${makeDocsLinkStyled("using-garden/configuration-overview", "#including-excluding-files-and-directories")} for details.
            `,
          })
        }

        files = sortBy(files, "path")
          // Don't include the config file in the file list
          .filter((f) => !configPath || f.path !== configPath)

        let stringsForContenthash: string[]
        if (configPath) {
          // Include the relative path to the file to account for the file being renamed or moved around within the
          // config path (e.g. renaming).
          const configDir = dirname(configPath)
          stringsForContenthash = files.map((f) => `${relative(configDir, f.path)}-${f.hash}`)
        } else {
          stringsForContenthash = files.map((f) => f.hash)
        }
        result.contentHash = hashStrings(stringsForContenthash)
        result.files = files.map((f) => f.path)
      }

      this.cache.set(log, cacheKey, result, pathToCacheContext(path))
    })

    return result
  }

  /**
   * Write a file and ensure relevant caches are invalidated after writing.
   */
  async writeFile(log: Log, path: string, data: string | Buffer) {
    await writeFile(path, data)
    this.cache.invalidateUp(log, pathToCacheContext(path))
  }

  /**
   * Returns a map of the optimal paths for each of the given action/module source path.
   * This is used to avoid scanning more of each git repository than necessary, and
   * reduces duplicate scanning of the same directories (since fewer unique roots mean
   * more tree cache hits).
   */
  async getMinimalRoots(log: Log, paths: string[]) {
    const repoRoots: { [path: string]: string } = {}
    const outputs: { [path: string]: string } = {}
    const rootsToPaths: { [repoRoot: string]: string[] } = {}

    await Promise.all(
      paths.map(async (path) => {
        const repoRoot = await this.getRepoRoot(log, path)
        repoRoots[path] = repoRoot
        if (rootsToPaths[repoRoot]) {
          rootsToPaths[repoRoot].push(path)
        } else {
          rootsToPaths[repoRoot] = [path]
        }
      })
    )

    for (const path of paths) {
      const repoRoot = repoRoots[path]
      const repoPaths = rootsToPaths[repoRoot]

      for (const repoPath of repoPaths) {
        if (!outputs[path]) {
          // No path set so far
          outputs[path] = repoPath
        } else if (outputs[path].startsWith(repoPath)) {
          // New path is prefix of prior path
          outputs[path] = repoPath
        } else {
          // Find common prefix
          let p = repoPath

          while (true) {
            p = splitLast(p, sep)[0]
            if (p.length < repoRoot.length) {
              // Don't go past the actual git repo root
              outputs[path] = repoRoot
              break
            } else if (outputs[path].startsWith(p)) {
              // Found a common prefix
              outputs[path] = p
              break
            }
          }
        }
      }
    }

    return outputs
  }

  /**
   * Returns the absolute path to the local directory for all remote sources
   */
  getRemoteSourcesLocalPath(type: ExternalSourceType) {
    return getRemoteSourcesPath({ gardenDirPath: this.gardenDirPath, type })
  }

  /**
   * Returns the absolute path to the local directory for the remote source
   */
  getRemoteSourceLocalPath(name: string, url: string, type: ExternalSourceType) {
    return getRemoteSourceLocalPath({ gardenDirPath: this.gardenDirPath, name, url, type })
  }
}

/**
 * We prefix with "v-" to prevent this.version from being read as a number when only a prefix of the
 * commit hash is used, and that prefix consists of only numbers. This can cause errors in certain contexts
 * when the version string is used in template variables in configuration files.
 */
export function getModuleVersionString(
  moduleConfig: ModuleConfig,
  treeVersion: NamedTreeVersion,
  dependencyModuleVersions: NamedModuleVersion[]
) {
  // TODO: allow overriding the prefix
  return `${versionStringPrefix}${hashModuleVersion(moduleConfig, treeVersion, dependencyModuleVersions)}`
}

/**
 * Compute the version of the given module, based on its configuration and the versions of its build dependencies.
 * The versions argument should consist of moduleConfig's tree version, and the tree versions of its dependencies.
 */
export function hashModuleVersion(
  moduleConfig: ModuleConfig,
  treeVersion: NamedTreeVersion,
  dependencyModuleVersions: NamedModuleVersion[]
) {
  // If a build config is provided, we use that.
  // Otherwise, we use the full module config, omitting the configPath, path, and outputs fields, as well as individual
  // entity configuration fields, as these often vary between environments and runtimes but are unlikely to impact the
  // build output.
  const configToHash =
    moduleConfig.buildConfig ||
    pick(moduleConfig, ["apiVersion", "name", "spec", "type", "variables", "varfile", "inputs"])

  const configString = serializeConfig(configToHash)

  const versionStrings = sortBy(
    [[treeVersion.name, treeVersion.contentHash], ...dependencyModuleVersions.map((v) => [v.name, v.versionString])],
    (vs) => vs[0]
  ).map((vs) => vs[1])

  return hashStrings([configString, ...versionStrings])
}

/**
 * Return the version string for the given Stack Graph entity (i.e. service, task or test).
 * It is simply a hash of the module version and the configuration of the entity.
 *
 * @param module        The module containing the entity in question
 * @param entityConfig  The configuration of the entity
 */
export function getEntityVersion(module: GardenModule, entityConfig: ServiceConfig | TaskConfig | TestConfig) {
  const configString = serializeConfig(entityConfig)
  return `${versionStringPrefix}${hashStrings([module.version.versionString, configString])}`
}

export function hashStrings(hashes: string[]) {
  const versionHash = createHash("sha256")
  versionHash.update(hashes.join("."))
  return versionHash.digest("hex").slice(0, 10)
}

export function getResourceTreeCacheKey(config: ModuleConfig | BaseActionConfig) {
  const cacheKey = ["source", getSourcePath(config)]

  if (config.include) {
    cacheKey.push("include", hashStrings(config.include.sort()))
  }
  if (config.exclude) {
    cacheKey.push("exclude", hashStrings(config.exclude.sort()))
  }

  return cacheKey
}

export function getConfigFilePath(config: ModuleConfig | BaseActionConfig) {
  return isActionConfig(config) ? config.internal?.configFilePath : config.configPath
}

export function getSourcePath(config: ModuleConfig | BaseActionConfig) {
  if (isActionConfig(config)) {
    const basePath = config.internal.basePath
    const sourceRelPath = config.source?.path
    return sourceRelPath ? getSourceAbsPath(basePath, sourceRelPath) : basePath
  } else {
    return config.path
  }
}

export function describeConfig(config: ModuleConfig | BaseActionConfig): ActionDescription | ModuleDescription {
  return isActionConfig(config) ? `${config.kind} action ${config.name}` : `module ${config.name}`
}
