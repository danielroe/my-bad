import process from 'node:process'

// Usage: node run.mjs <sidecar|inline> <fn>
// Prints the thrown error as JSON so a test can rebuild it in-process.
const [variant, fn] = process.argv.slice(2)

function serialize(e) {
  return e instanceof Error
    ? { name: e.name, message: e.message, stack: e.stack, cause: e.cause === undefined ? undefined : serialize(e.cause) }
    : e
}

async function main() {
  const mod = await import(`./dist/${variant}/thrower.mjs`)
  try {
    await mod[fn]('')
    throw new Error('expected a throw')
  }
  catch (error) {
    process.stdout.write(JSON.stringify(serialize(error)))
  }
}

main()
