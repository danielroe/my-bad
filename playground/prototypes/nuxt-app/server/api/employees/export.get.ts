import { parseDirectoryExport } from '../../../shared/directory'
import { directoryExport } from '../../../shared/scenario-inputs'
import { readEmployees } from '../../utils/employees'

export default defineEventHandler(async () => {
  const contents = directoryExport(await readEmployees())
  return parseDirectoryExport(contents)
})
