import { greet } from './broken'

document.querySelector('#out')!.textContent = greet('world')
