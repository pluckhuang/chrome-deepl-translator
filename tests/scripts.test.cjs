const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8' });

test('本地模型安装脚本语法正确，参数错误时不改动系统直接退出', () => {
    assert.equal(run('bash', ['-n', 'scripts/setup-local-model.sh']).status, 0);
    assert.equal(run('sh', ['-n', 'scripts/ollama-env.sh']).status, 0);
    const help = run('bash', ['scripts/setup-local-model.sh', '--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--uninstall/);
    for (const args of [['--bogus'], ['--parallel']]) {
        const result = run('bash', ['scripts/setup-local-model.sh', ...args]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /未知参数|需要一个值/);
    }
});
