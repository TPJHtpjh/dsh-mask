/**
 * Worker entry for the provenance scan.
 *
 * The scan reads thousands of package files; doing that on the Host's main loop
 * would stall every session for seconds, so it runs here instead and posts the
 * result back. The parent never waits on it — the catalog serves whatever the
 * cache already holds and this fills it in.
 *
 * The archive path is resolved by the PARENT and passed in. `asarPath()` depends
 * on `process.resourcesPath`, which only an Electron main process has; resolving
 * it independently here would make the worker's view of the machine differ from
 * the plugin's for no reason, and a wrong path silently degrades the scan to
 * profile-only instead of failing.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { scanProvenance, installedPackages } from './provenance.js'

const { profileDir, archive } = workerData
try {
  const started = Date.now()
  const scan = scanProvenance(profileDir, archive)
  parentPort.postMessage({
    ok: true,
    scan,
    started,
    tookMs: Date.now() - started,
    packages: installedPackages(profileDir).length,
  })
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message ?? error) })
}
