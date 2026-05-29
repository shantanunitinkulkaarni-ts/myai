import { runTool } from './src/tools.js';

async function testDeploy() {
  console.log('Testing deploy_gcp tool directly...');
  const result = await runTool({ tool: 'deploy_gcp' });
  console.log('Deploy Result:', JSON.stringify(result, null, 2));
}

testDeploy();
