/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { DeployCommand } from "../../../../src/commands/deploy"
import { expect } from "chai"
import {
  taskResultOutputs,
  withDefaultGlobalOpts,
  makeTestGarden,
  getRuntimeStatusEventsWithoutTimestamps,
  customizedTestPlugin,
  testDeploySchema,
  testTestSchema,
  getAllProcessedTaskNames,
  getDataDir,
  expectError,
} from "../../../helpers"
import { sortBy } from "lodash"
import { getLogger } from "../../../../src/logger/logger"
import { ActionStatus } from "../../../../src/actions/types"
import { makeDummyGarden } from "../../../../src/cli/cli"
import { ActionStatusPayload } from "../../../../src/events"

// TODO-G2: rename test cases to match the new graph model semantics
const placeholderTimestamp = new Date()

const testProvider = () => {
  const testStatuses: { [key: string]: ActionStatus } = {
    "service-a": {
      state: "ready",
      detail: {
        state: "ready",
        detail: {},
        ingresses: [
          {
            hostname: "service-a.test-project-b.local.app.garden",
            path: "/path-a",
            port: 80,
            protocol: "http",
          },
        ],
      },
      outputs: {},
    },
    "service-c": {
      state: "ready",
      detail: { state: "ready", detail: {} },
      outputs: {},
    },
  }

  return customizedTestPlugin({
    name: "test-plugin",
    createActionTypes: {
      Deploy: [
        {
          name: "test",
          docs: "Test Deploy action",
          schema: testDeploySchema(),
          handlers: {
            deploy: async (params) => {
              const newStatus: ActionStatus = { state: "ready", detail: { state: "ready", detail: {} }, outputs: {} }
              testStatuses[params.action.name] = newStatus
              return newStatus
            },
            getStatus: async (params) => {
              return (
                testStatuses[params.action.name] || {
                  state: "unknown",
                  detail: { state: "unknown", detail: {} },
                  outputs: {},
                }
              )
            },
            exec: async ({ action }) => {
              const { command } = action.getSpec()
              return { code: 0, output: "Ran command: " + command.join(" ") }
            },
          },
        },
      ],
      Run: [
        {
          name: "test",
          docs: "Test Run action",
          schema: testTestSchema(),
          handlers: {
            run: async ({}) => {
              return {
                state: "ready",
                outputs: {},
                detail: {
                  success: true,
                  startedAt: placeholderTimestamp,
                  completedAt: placeholderTimestamp,
                  log: "OK",
                },
              }
            },
          },
        },
      ],
    },
  })
}

describe("DeployCommand", () => {
  const projectRootB = getDataDir("test-project-b")
  const projectRootA = getDataDir("test-project-a")

  // TODO: Verify that services don't get redeployed when same version is already deployed.

  const command = new DeployCommand()

  it("should build and deploy everything in a project, and execute Run dependencies", async () => {
    const garden = await makeTestGarden(projectRootB, { plugins: [testProvider()] })
    const log = garden.log

    const { result, errors } = await command.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: {
        names: undefined,
      },
      opts: withDefaultGlobalOpts({
        "sync": undefined,
        "local-mode": undefined,
        "watch": false,
        "force": false,
        "force-build": true,
        "skip": undefined,
        "skip-dependencies": false,
        "skip-watch": false,
        "forward": false,
      }),
    })

    if (errors?.length) {
      throw errors[0]
    }

    expect(command.outputsSchema().validate(result).error).to.be.undefined

    expect(Object.keys(taskResultOutputs(result!)).sort()).to.eql([
      "deploy.service-a",
      "deploy.service-b",
      "deploy.service-c",
      "deploy.service-d",
    ])

    const deployResults = result!.graphResults

    const graph = await garden.getResolvedConfigGraph({ log: garden.log, emit: false })

    const sortedEvents = sortBy(
      getRuntimeStatusEventsWithoutTimestamps(garden.events.eventLog),
      (e) => `${e.name}.${e.payload.actionName}.${e.payload.status.state}`
    )

    const getActionUid = (actionName: string): string => {
      const event = sortedEvents.find((e: { payload: ActionStatusPayload<{}> }) => {
        return e.payload.actionName === actionName && !!e.payload.actionUid
      })
      if (!event) {
        throw new Error(`No event with an actionUid found for action name ${actionName}`)
      }
      return event.payload.actionUid
    }

    const getModuleVersion = (moduleName: string) => graph.getModule(moduleName).version.versionString
    const getDeployVersion = (serviceName: string) => graph.getDeploy(serviceName).versionString()
    const getRunVersion = (taskName: string) => graph.getRun(taskName).versionString()

    for (const graphResult of Object.values(deployResults)) {
      expect(graphResult).to.exist

      // Won't happen, but chai expect doesn't serve as a typeguard :(
      if (graphResult === null) {
        continue
      }

      expect(graphResult.name).to.exist
      expect(graphResult.version).to.equal(getDeployVersion(graphResult.name))
      expect(graphResult.aborted).to.be.false
      expect(graphResult.error).to.be.null
      expect(graphResult.result).to.exist
      expect(graphResult.startedAt).to.be.instanceOf(Date)
      expect(graphResult.completedAt).to.be.instanceOf(Date)

      const { result: res } = graphResult

      expect(res.state).to.equal("ready")
      expect(res.outputs).to.eql({})
    }

  })

  it("should optionally build and deploy single service and its dependencies", async () => {
    const garden = await makeTestGarden(projectRootB, { plugins: [testProvider()] })
    const log = garden.log

    const { result, errors } = await command.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: {
        names: ["service-b"],
      },
      opts: withDefaultGlobalOpts({
        "sync": undefined,
        "local-mode": undefined,
        "watch": false,
        "force": false,
        "force-build": true,
        "skip": undefined,
        "skip-dependencies": false,
        "skip-watch": false,
        "forward": false,
      }),
    })

    if (errors) {
      throw errors[0]
    }

    const keys = getAllProcessedTaskNames(result!.graphResults)

    expect(keys).to.eql([
      "build.module-a",
      "build.module-b",
      "deploy.service-a",
      "deploy.service-b",
      "resolve-action.build.module-a",
      "resolve-action.build.module-b",
      "resolve-action.build.module-c",
      "resolve-action.deploy.service-a",
      "resolve-action.deploy.service-b",
      "resolve-action.run.task-a",
      "resolve-action.run.task-b",
      "resolve-action.run.task-c",
      "run.task-b",
    ])
  })

  context("when --skip-dependencies is passed", () => {
    it("should not process runtime dependencies for the requested services", async () => {
      const garden = await makeTestGarden(projectRootA, { plugins: [testProvider()] })
      const log = garden.log

      const { result, errors } = await command.action({
        garden,
        log,
        headerLog: log,
        footerLog: log,
        args: {
          names: ["service-b", "service-c"],
        },
        opts: withDefaultGlobalOpts({
          "sync": undefined,
          "local-mode": undefined,
          "watch": false,
          "force": false,
          "force-build": true,
          "skip": undefined,
          "skip-dependencies": true, // <-----
          "skip-watch": false,
          "forward": false,
        }),
      })

      if (errors) {
        throw errors[0]
      }

      const keys = getAllProcessedTaskNames(result!.graphResults)

      // service-b has a dependency on service-a, it should be skipped here
      expect(keys).to.not.include("deploy.service-a")

      // service-c has a dependency on task-c, it should be skipped here
      expect(keys).to.not.include("run.task-c")

      // Specified services should be deployed
      expect(keys).to.include("deploy.service-b")
      expect(keys).to.include("deploy.service-c")
    })
  })

  it("should be protected", async () => {
    expect(command.protected).to.be.true
  })

  it("should skip disabled services", async () => {
    const garden = await makeTestGarden(projectRootB, { plugins: [testProvider()] })
    const log = garden.log

    await garden.scanAndAddConfigs()
    garden["moduleConfigs"]["module-c"].spec.services[0].disabled = true

    const { result, errors } = await command.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: {
        names: undefined,
      },
      opts: withDefaultGlobalOpts({
        "sync": undefined,
        "local-mode": undefined,
        "watch": false,
        "force": false,
        "force-build": true,
        "skip": undefined,
        "skip-dependencies": false,
        "skip-watch": false,
        "forward": false,
      }),
    })

    if (errors) {
      throw errors[0]
    }

    expect(Object.keys(result!.graphResults).sort()).to.eql([
      "deploy.service-a",
      "deploy.service-b",
      "deploy.service-d",
    ])
  })

  it("should skip services from disabled modules", async () => {
    const garden = await makeTestGarden(projectRootB, { plugins: [testProvider()] })
    const log = garden.log

    await garden.scanAndAddConfigs()
    garden["moduleConfigs"]["module-c"].disabled = true

    const { result, errors } = await command.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: {
        names: undefined,
      },
      opts: withDefaultGlobalOpts({
        "sync": undefined,
        "local-mode": undefined,
        "watch": false,
        "force": false,
        "force-build": true,
        "skip": undefined,
        "skip-dependencies": false,
        "skip-watch": false,
        "forward": false,
      }),
    })

    if (errors) {
      throw errors[0]
    }

    expect(Object.keys(result!.graphResults).sort()).to.eql(["deploy.service-a", "deploy.service-b"])
  })

  it("should skip services set in the --skip option", async () => {
    const garden = await makeTestGarden(projectRootB, { plugins: [testProvider()] })
    const log = garden.log

    await garden.scanAndAddConfigs()

    const { result, errors } = await command.action({
      garden,
      log,
      headerLog: log,
      footerLog: log,
      args: {
        names: undefined,
      },
      opts: withDefaultGlobalOpts({
        "sync": undefined,
        "local-mode": undefined,
        "watch": false,
        "force": false,
        "force-build": true,
        "skip": ["service-b"],
        "skip-dependencies": false,
        "skip-watch": false,
        "forward": false,
      }),
    })

    if (errors) {
      throw errors[0]
    }

    expect(Object.keys(taskResultOutputs(result!)).includes("deploy.service-b")).to.be.false
  })

  describe("isPersistent", () => {
    it("should return persistent=true if --sync is set", async () => {
      const cmd = new DeployCommand()
      const log = getLogger().makeNewLogContext()
      const persistent = cmd.isPersistent({
        log,
        headerLog: log,
        footerLog: log,
        args: {
          names: undefined,
        },
        opts: withDefaultGlobalOpts({
          "sync": [],
          "local-mode": undefined,
          "watch": false,
          "force": false,
          "force-build": true,
          "skip": ["service-b"],
          "skip-dependencies": false,
          "skip-watch": false,
          "forward": false,
        }),
      })
      expect(persistent).to.be.true
    })

    it("should return persistent=true if --local-mode is set", async () => {
      const cmd = new DeployCommand()
      const log = getLogger().makeNewLogContext()
      const persistent = cmd.isPersistent({
        log,
        headerLog: log,
        footerLog: log,
        args: {
          names: undefined,
        },
        opts: withDefaultGlobalOpts({
          "sync": undefined,
          "local-mode": [],
          "watch": false,
          "force": false,
          "force-build": true,
          "skip": ["service-b"],
          "skip-dependencies": false,
          "skip-watch": false,
          "forward": false,
        }),
      })
      expect(persistent).to.be.true
    })

    it("should return persistent=true if --follow is set", async () => {
      const cmd = new DeployCommand()
      const log = getLogger().makeNewLogContext()
      const persistent = cmd.isPersistent({
        log,
        headerLog: log,
        footerLog: log,
        args: {
          names: undefined,
        },
        opts: withDefaultGlobalOpts({
          "sync": undefined,

          "local-mode": undefined,
          "watch": false,
          "force": false,
          "force-build": true,
          "skip": ["service-b"],
          "skip-dependencies": false,
          "skip-watch": false,
          "forward": true,
        }),
      })
      expect(persistent).to.be.true
    })
  })
})
