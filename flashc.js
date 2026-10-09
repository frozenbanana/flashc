#!/usr/bin/env node
// flashc — Google Sheet backed flashcards with SM-2 scheduling and Thai TTS.
// Commands:
//   setup     interactive: configure sheet URL + column mapping
//   sync      fetch sheet, register new words / update existing
//   review    start a review session (default when no command given)
//   stats     show progress overview
//   list      list all cards

import { main } from './src/cli.js';

main(process.argv.slice(2));
