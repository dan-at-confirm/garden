/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import Bluebird from "bluebird"
import {
  ConfigGraph,
  Garden,
  LogEntry,
  PluginCommand,
  PluginCommandParams,
  PluginContext,
  GraphResults,
  PluginActionTask,
} from "@garden-io/sdk/types"

import { PulumiDeploy, PulumiProvider } from "./config"
import { Profile } from "@garden-io/core/build/src/util/profiling"
import {
  cancelUpdate,
  getModifiedPlansDirPath,
  getPlanFileName,
  getPreviewDirPath,
  previewStack,
  PulumiParams,
  refreshResources,
  reimportStack,
  selectStack,
} from "./helpers"
import { dedent, deline } from "@garden-io/sdk/util/string"
import { BooleanParameter, parsePluginCommandArgs } from "@garden-io/sdk/util/cli"
import { copy, emptyDir } from "fs-extra"
import { join } from "path"
import { isDeployAction } from "@garden-io/core/build/src/actions/deploy"
import { ActionConfigContext } from "@garden-io/core/build/src/config/template-contexts/actions"
import { ActionTaskProcessParams, ValidResultType } from "@garden-io/core/build/src/tasks/base"
import { deletePulumiDeploy } from "./handlers"

type PulumiBaseParams = Omit<PulumiParams, "action">

type PulumiRunFn = (params: PulumiParams) => Promise<any>

interface PulumiCommandSpec {
  name: string
  commandDescription: string
  beforeFn?: ({ ctx, log }: { ctx: PluginContext; log: LogEntry }) => Promise<any>
  runFn: PulumiRunFn
  afterFn?: ({
    ctx,
    log,
    results,
    pulumiTasks,
  }: {
    ctx: PluginContext
    log: LogEntry
    results: GraphResults
    pulumiTasks: PulumiPluginCommandTask[]
  }) => Promise<any>
}

// TODO-G2-thor: Re-enable and test when 0.13 is stable enough to run commands.
// interface TotalSummary {
//   /**
//    * The ISO timestamp of when the plan was completed.
//    */
//   completedAt: string
//   /**
//    * The total number of operations by step type (excluding `same` steps).
//    */
//   totalStepCounts: OperationCounts
//   /**
//    * A more detailed summary for each pulumi service affected by the plan.
//    */
//   results: {
//     [serviceName: string]: PreviewResult
//   }
// }

const pulumiCommandSpecs: PulumiCommandSpec[] = [
  {
    name: "preview",
    commandDescription: "pulumi preview",
    beforeFn: async ({ ctx, log }) => {
      const previewDirPath = getPreviewDirPath(ctx)
      // We clear the preview dir, so that it contains only the plans generated by this preview command.
      log.debug(`Clearing preview dir at ${previewDirPath}...`)
      await emptyDir(previewDirPath)
    },
    runFn: async (params) => {
      const { ctx, action, log } = params
      const previewDirPath = getPreviewDirPath(ctx)
      const { affectedResourcesCount, operationCounts, previewUrl, planPath } = await previewStack({
        ...params,
        logPreview: true,
        previewDirPath,
      })
      if (affectedResourcesCount > 0) {
        // We copy the plan to a subdirectory of the preview dir.
        // This is to facilitate copying only those plans that aren't no-ops out of the preview dir for subsequent
        // use in a deployment.
        const planFileName = getPlanFileName(action, ctx.environmentName)
        const modifiedPlanPath = join(getModifiedPlansDirPath(ctx), planFileName)
        await copy(planPath, modifiedPlanPath)
        log.debug(`Copied plan to ${modifiedPlanPath}`)
        return {
          affectedResourcesCount,
          operationCounts,
          modifiedPlanPath,
          previewUrl,
        }
      } else {
        return null
      }
    },
    // TODO-G2-thor: Re-enable and test when 0.13 is stable enough to run commands.
    // afterFn: async ({ ctx, log, results, pulumiTasks }) => {
    //   // No-op plans (i.e. where no resources were changed) are omitted here.
    //   const pulumiTaskResults = Object.fromEntries(
    //     pulumiTasks.map((t) => [t.getName(), results.getResult(t)?.outputs || null])
    //   )
    //   const totalStepCounts: OperationCounts = {}
    //   for (const result of Object.values(pulumiTaskResults)) {
    //     const opCounts = (<PreviewResult>result).operationCounts
    //     for (const [stepType, count] of Object.entries(opCounts)) {
    //       totalStepCounts[stepType] = (totalStepCounts[stepType] || 0) + count
    //     }
    //   }
    //   const totalSummary: TotalSummary = {
    //     completedAt: new Date().toISOString(),
    //     totalStepCounts,
    //     results: pulumiTaskResults,
    //   }
    //   const previewDirPath = getPreviewDirPath(ctx)
    //   const summaryPath = join(previewDirPath, "plan-summary.json")
    //   await writeJSON(summaryPath, totalSummary, { spaces: 2 })
    //   log.info("")
    //   log.info(chalk.green(`Wrote plan summary to ${chalk.white(summaryPath)}`))
    //   return totalSummary
    // },
  },
  {
    name: "cancel",
    commandDescription: "pulumi cancel",
    runFn: async (params) => await cancelUpdate(params),
  },
  {
    name: "refresh",
    commandDescription: "pulumi refresh",
    runFn: async (params) => await refreshResources(params),
  },
  {
    name: "reimport",
    commandDescription: "pulumi export | pulumi import",
    runFn: async (params) => await reimportStack(params),
  },
  {
    name: "destroy",
    commandDescription: "pulumi destroy",
    runFn: async (params) => {
      if (params.action.getSpec("allowDestroy")) {
        await deletePulumiDeploy!(params)
      }
    },
  },
]

const makePluginContextForDeploy = async (params: PulumiParams & { garden: Garden; graph: ConfigGraph }) => {
  const { garden, provider, ctx } = params
  const templateContext = new ActionConfigContext(garden)
  const ctxForDeploy = await garden.getPluginContext({ provider, templateContext, events: ctx.events })
  return ctxForDeploy
}

interface PulumiPluginCommandTaskParams {
  garden: Garden
  graph: ConfigGraph
  log: LogEntry
  action: PulumiDeploy
  commandName: string
  commandDescription: string
  skipRuntimeDependencies: boolean
  runFn: PulumiRunFn
  pulumiParams: PulumiBaseParams
}

interface PulumiCommandResult extends ValidResultType {}

@Profile()
class PulumiPluginCommandTask extends PluginActionTask<PulumiDeploy, PulumiCommandResult> {
  pulumiParams: PulumiBaseParams
  commandName: string
  commandDescription: string
  skipRuntimeDependencies: boolean
  runFn: PulumiRunFn

  constructor({
    garden,
    graph,
    log,
    action,
    commandName,
    commandDescription,
    skipRuntimeDependencies = false,
    runFn,
    pulumiParams,
  }: PulumiPluginCommandTaskParams) {
    super({
      garden,
      log,
      force: false,
      action,
      graph,

      devModeDeployNames: [],
      localModeDeployNames: [],
    })
    this.commandName = commandName
    this.commandDescription = commandDescription
    this.skipRuntimeDependencies = skipRuntimeDependencies
    this.runFn = runFn
    this.pulumiParams = pulumiParams
    const provider = <PulumiProvider>pulumiParams.ctx.provider
    this.concurrencyLimit = provider.config.pluginTaskConcurrencyLimit
  }

  getDescription() {
    return this.action.longDescription()
  }

  resolveDependencies() {
    const pulumiDeployNames = this.graph
      .getDeploys()
      .filter((d) => d.type === "pulumi")
      .map((d) => d.name)

    const deps = this.graph
      .getDependencies({
        kind: "Deploy",
        name: this.getName(),
        recursive: false,
        filter: (depNode) => pulumiDeployNames.includes(depNode.name),
      })
      .filter(isDeployAction)

    const tasks = deps.map((action) => {
      return new PulumiPluginCommandTask({
        garden: this.garden,
        graph: this.graph,
        log: this.log,
        action,
        commandName: this.commandName,
        commandDescription: this.commandDescription,
        skipRuntimeDependencies: this.skipRuntimeDependencies,
        runFn: this.runFn,
        pulumiParams: this.pulumiParams,
      })
    })

    return [this.getResolveTask(this.action), ...tasks]
  }

  async getStatus() {
    return null
  }

  async process({ dependencyResults }: ActionTaskProcessParams<PulumiDeploy, PulumiCommandResult>) {
    const log = this.log.info({
      section: this.action.key(),
      msg: chalk.gray(`Running ${chalk.white(this.commandDescription)}`),
      status: "active",
    })

    const params = { ...this.pulumiParams, action: this.getResolvedAction(this.action, dependencyResults) }

    try {
      await selectStack(params)
      // We need to make sure that the template resolution context is specific to this service's module.
      const ctxForService = await makePluginContextForDeploy({
        ...params,
        garden: this.garden,
        graph: this.graph,
      })
      const result = await this.runFn({ ...params, ctx: ctxForService })
      log.setSuccess({
        msg: chalk.green(`Success (took ${log.getDuration(1)} sec)`),
      })
      return result
    } catch (err) {
      log.setError({
        msg: chalk.red(`Failed! (took ${log.getDuration(1)} sec)`),
      })
      throw err
    }
  }
}

export const getPulumiCommands = (): PluginCommand[] => pulumiCommandSpecs.map(makePulumiCommand)

function makePulumiCommand({ name, commandDescription, beforeFn, runFn, afterFn }: PulumiCommandSpec) {
  const description = commandDescription || `pulumi ${name}`
  const pulumiCommand = chalk.bold(description)

  const pulumiCommandOpts = {
    "skip-dependencies": new BooleanParameter({
      help: deline`Run ${pulumiCommand} for the specified services, but not for any pulumi services that they depend on
      (unless they're specified too).`,
      alias: "nodeps",
    }),
  }

  return {
    name,
    description: dedent`
      Runs ${pulumiCommand} for the specified pulumi actions, in dependency order (or for all pulumi actions if no
      names are provided).

      If the --skip-dependencies option is used, ${pulumiCommand} will only be run for the specified actions, but not any pulumi actions that they depend on (unless they're specified too).

      Note: The --skip-dependencies option has to be put after the -- when invoking pulumi plugin commands.
    `,
    resolveGraph: true,

    title: ({ args }) =>
      chalk.bold.magenta(`Running ${chalk.white.bold(pulumiCommand)} for actions ${chalk.white.bold(args[0] || "")}`),

    async handler({ garden, ctx, args, log, graph }: PluginCommandParams) {
      const parsed = parsePluginCommandArgs({
        stringArgs: args,
        optionSpec: pulumiCommandOpts,
        cli: true,
      })
      const { args: parsedArgs, opts } = parsed
      const skipRuntimeDependencies = opts["skip-dependencies"]
      const names = parsedArgs.length === 0 ? undefined : parsedArgs

      beforeFn && (await beforeFn({ ctx, log }))

      const provider = ctx.provider as PulumiProvider

      const actions = graph.getDeploys({ names }).filter((a) => a.type === "pulumi")

      const tasks = await Bluebird.map(actions, async (action) => {
        const templateContext = new ActionConfigContext(garden)
        const pulumiParams: PulumiBaseParams = {
          ctx: await garden.getPluginContext({ provider, templateContext, events: ctx.events }),
          provider,
          log,
        }
        return new PulumiPluginCommandTask({
          garden,
          graph,
          log,
          action,
          commandName: name,
          commandDescription,
          skipRuntimeDependencies,
          runFn,
          pulumiParams,
        })
      })

      const results = (await garden.processTasks({ log, tasks, throwOnError: true })).results

      let commandResult: any = {}
      if (afterFn) {
        commandResult = await afterFn({ ctx, log, results, pulumiTasks: tasks })
      }

      return { result: commandResult }
    },
  }
}
