import test from 'node:test';
import assert from 'node:assert/strict';
import { architectureOf, modelChoices, selectedChoice, validateModelSelection, modelSelectionPatch } from '../gateway/src/lib/model-catalog.mjs';

const ferryModels = [
  { name: 'GPT-6.1-Sol', codex: 'ferry-gpt-6-1-sol', trae: 'gpt-6.1-sol__dev', context: 475000, efforts: ['low', 'medium', 'high', 'xhigh'], acceleration_supported: true },
  { name: 'GPT-6.1-Sol Max 1M', codex: 'ferry-gpt-6-1-sol-max', trae: 'gpt-6.1-sol__max', context: 1000000, efforts: ['low', 'medium', 'high', 'xhigh'], acceleration_supported: true },
  { name: 'Other', codex: 'ferry-other', trae: 'other__dev', context: 1000000, efforts: ['medium'] },
];
const nativeCatalog = {
  models: ['GPT-6.1-Sol', 'Other'],
  modelCapabilities: [{ slug: 'GPT-6.1-Sol', contextVariants: [
    { id: 'standard', contextWindow: 475000, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'max', contextWindow: 800000, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
  ] }],
};

test('architecture comes from the configured CLI, not the Bot name', () => {
  assert.equal(architectureOf({ name: 'Codex', cliId: 'traex' }), 'traex');
  assert.equal(architectureOf({ name: 'TraeX', cliId: 'claude-code' }), null);
});

test('Codex choices use Ferry model IDs and exclude non-GPT entries', () => {
  const bot = { cliId: 'codex', reasoningEffort: 'xhigh' };
  const choices = modelChoices(bot, ferryModels);
  assert.deepEqual(choices.map(choice => choice.clientModel), ['ferry-gpt-6-1-sol', 'ferry-gpt-6-1-sol-max']);
  assert.equal(choices[1].contextWindow, 1000000);
});

test('TraeX maps the native model and variant without expanding its context budget', () => {
  const bot = { cliId: 'traex', model: 'GPT-6.1-Sol', modelBackendVariant: 'max', reasoningEffort: 'xhigh' };
  const choices = modelChoices(bot, ferryModels, nativeCatalog);
  assert.equal(choices[1].clientModel, 'GPT-6.1-Sol');
  assert.equal(choices[1].backendVariant, 'max');
  assert.equal(choices[1].contextWindow, 800000);
  assert.equal(selectedChoice(bot, choices)?.id, 'ferry-gpt-6-1-sol-max');
});

test('missing native variant or effort evidence does not create a TraeX option', () => {
  const bot = { cliId: 'traex' };
  assert.deepEqual(modelChoices(bot, ferryModels, { models: ['GPT-6.1-Sol'] }), []);
  assert.deepEqual(modelChoices(bot, ferryModels, { ...nativeCatalog, models: [] }), []);
});

test('selection rejects unsupported models, architectures and automatic model pools', () => {
  const bot = { cliId: 'traex', reasoningEffort: 'xhigh' };
  const choices = modelChoices(bot, ferryModels, nativeCatalog);
  assert.throws(() => validateModelSelection(bot, choices, 'Other'), /固定 GPT/);
  assert.throws(() => validateModelSelection({ ...bot, cliId: 'other' }, choices, choices[0].id), /架构/);
  assert.throws(() => validateModelSelection({ ...bot, traexAutoModel: { enabled: true } }, choices, choices[0].id), /自动选模/);
});

test('selection never silently lowers the requested effort', () => {
  const bot = { cliId: 'codex', reasoningEffort: 'ultra' };
  const choices = modelChoices(bot, ferryModels);
  assert.equal(choices[0].availableForEffort, false);
  assert.throws(() => validateModelSelection(bot, choices, choices[0].id), /不会自动降档/);
});

test('selection patch changes only the native model and required variant', () => {
  const bot = { cliId: 'traex', reasoningEffort: 'xhigh', model: 'GPT-6.1-Sol' };
  const choice = validateModelSelection(bot, modelChoices(bot, ferryModels, nativeCatalog), 'ferry-gpt-6-1-sol-max');
  assert.deepEqual(modelSelectionPatch(bot, choice), { model: 'GPT-6.1-Sol', modelBackendVariant: 'max' });
  assert.throws(() => modelSelectionPatch({ ...bot, cliId: 'codex' }, choice), /架构已经变化/);
});

test('invalid or duplicate remote catalog entries are not offered', () => {
  const choices = modelChoices({ cliId: 'codex' }, [...ferryModels, ferryModels[0],
    { codex: 'ferry-gpt-test', context: -1, efforts: ['medium'] },
    { codex: 'ferry-gpt-other', context: 5000, efforts: [] }]);
  assert.equal(choices.length, 2);
});
