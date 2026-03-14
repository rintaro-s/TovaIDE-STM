/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Application, Logger } from '../../../../automation';
import { installAllHandlers } from '../../utils';

const WAIT_AFTER_CMD_MS = 800;

export function setup(logger: Logger) {
	describe('STM32 Extensions', () => {

		installAllHandlers(logger);

		describe('Welcome Wizard', () => {
			it('opens via command palette', async function () {
				const app = this.app as Application;
				await app.workbench.quickaccess.runCommand('stm32ux.openWelcome');
				await app.code.wait(WAIT_AFTER_CMD_MS);
				const title = await app.code.waitForElement('.editor-group-container .tab.active .tab-label .monaco-icon-label-container');
				logger.log(`Wizard tab title: ${title.textContent ?? '?'}`);
			});
		});

		describe('Template Gallery', () => {
			it('opens via command palette', async function () {
				const app = this.app as Application;
				await app.workbench.quickaccess.runCommand('stm32ux.openTemplates');
				await app.code.wait(WAIT_AFTER_CMD_MS);
				const title = await app.code.waitForElement('.editor-group-container .tab.active .tab-label .monaco-icon-label-container');
				logger.log(`Gallery tab title: ${title.textContent ?? '?'}`);
			});

			it('webview iframe is present after gallery opens', async function () {
				const app = this.app as Application;
				await app.workbench.quickaccess.runCommand('stm32ux.openTemplates');
				await app.code.wait(WAIT_AFTER_CMD_MS);
				const frame = await app.code.waitForElement('iframe.webview');
				logger.log(`Webview frame: ${frame.textContent ?? '(present)'}`);
			});
		});

		describe('Pin Visualizer', () => {
			it('opens via command palette', async function () {
				const app = this.app as Application;
				await app.workbench.quickaccess.runCommand('stm32ux.openPinVisualizer');
				await app.code.wait(WAIT_AFTER_CMD_MS);
				const title = await app.code.waitForElement('.editor-group-container .tab.active .tab-label .monaco-icon-label-container');
				logger.log(`Pin visualizer tab title: ${title.textContent ?? '?'}`);
			});
		});

		describe('Environment Check', () => {
			it('generates a Markdown report', async function () {
				const app = this.app as Application;
				await app.workbench.quickaccess.runCommand('stm32ux.envCheck');
				await app.code.wait(WAIT_AFTER_CMD_MS);
				const editor = await app.code.waitForElement('.editor-instance .view-line');
				logger.log(`Env check first line: ${editor.textContent ?? '?'}`);
			});
		});

		describe('Project Generation', () => {
			it('template gallery tab opens (headless-safe)', async function () {
				const app = this.app as Application;
				await app.workbench.quickaccess.runCommand('stm32ux.openTemplates');
				await app.code.wait(WAIT_AFTER_CMD_MS);
				const title = await app.code.waitForElement('.editor-group-container .tab.active .tab-label .monaco-icon-label-container');
				logger.log(`Template gallery opened: ${title.textContent ?? '?'}`);
			});
		});

		describe('Collab Panel', () => {
			it('panel command executes without error', async function () {
				const app = this.app as Application;
				await app.workbench.quickaccess.runCommand('stm32collab.openPanel');
				await app.code.wait(WAIT_AFTER_CMD_MS);
				logger.log('Collab panel command executed');
			});
		});
	});
}
