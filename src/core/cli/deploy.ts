import { Command } from './command';

function main(args: []) {
  console.log('Running deploy...');
}

class Deploy extends Command {
  async run(args: []) {
    main(args);
    console.log('Stop deploy...');
  }
}

const deploy = new Deploy();

export default deploy;