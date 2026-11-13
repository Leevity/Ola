import { pathToFileURL } from 'node:url'

// utilityProcess gives the child a parentPort; a plain Node fork does not. This
// adapter lets the crash test kill a real process without the production entry
// carrying a second transport.
process.parentPort = {
  postMessage: (value) => process.send(value),
  on: (event, listener) => {
    process.on(event, (data) => listener({ data }))
  }
}

await import(pathToFileURL(process.argv[2]).href)
