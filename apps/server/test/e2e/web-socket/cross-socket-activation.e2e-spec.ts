import { PrismaService } from 'nestjs-prisma';
import { ClientMessageKind, RulesType, ServerMessageKind } from '@usertour/types';

import { initialization } from '@/common/initialization/initialization';
import {
  buildContent,
  buildEnvironment,
  buildProject,
  buildStep,
  buildVersion,
  publishVersion,
} from '../factories';
import { teardownProject } from '../gql/_support';
import {
  WebSocketTestApp,
  WebSocketTestClient,
  connectWebSocketClient,
  createWebSocketTestApp,
} from './_support';

/**
 * Cross-socket activation must respect each socket's own page context.
 *
 * When content starts in one tab the server activates it on every other socket
 * in the user's room. That fan-out delivers the originating session verbatim,
 * so without a per-socket check a hide rule excluding the target tab's page is
 * bypassed: an already-open tab shows content it would never be sent on a fresh
 * load. Covers flows and banners, since the leak is above the content-type
 * dispatch.
 */
describe('WebSocket v2 cross-socket activation honours hide rules (e2e)', () => {
  let harness: WebSocketTestApp;
  let prisma: PrismaService;
  let projectId: string;
  let environmentId: string;
  let environmentToken: string;

  const externalUserId = `ws-cross-socket-user-${Date.now()}`;

  const ALLOWED_PAGE = 'https://example.test/app';
  const OTHER_ALLOWED_PAGE = 'https://example.test/dashboard';
  const HIDDEN_PAGE = 'https://example.test/checkout';

  let flowContentId: string;
  let bannerContentId: string;

  const openClients: WebSocketTestClient[] = [];

  /** Connect as the same user, on a specific page. */
  const connectOnPage = async (pageUrl: string) => {
    const client = await connectWebSocketClient(harness.baseUrl, {
      token: environmentToken,
      externalUserId,
      clientContext: { pageUrl, viewportWidth: 1280, viewportHeight: 800 },
    });
    openClients.push(client);
    return client;
  };

  /**
   * "Hide on the checkout page" — the condition activates (and therefore
   * hides) when the current URL matches, so it blocks only HIDDEN_PAGE.
   */
  const hideOnCheckoutConfig = () => ({
    enabledAutoStartRules: false,
    enabledHideRules: true,
    autoStartRules: [],
    hideRules: [
      {
        id: 'hide-on-checkout',
        type: RulesType.CURRENT_PAGE,
        operators: 'and' as const,
        data: { includes: ['**/checkout**'], excludes: [] },
      },
    ],
    autoStartRulesSetting: {},
    hideRulesSetting: {},
  });

  beforeAll(async () => {
    harness = await createWebSocketTestApp();
    prisma = harness.app.get(PrismaService);

    const project = await buildProject(prisma, { name: 'ws-cross-socket-activation' });
    projectId = project.id;
    await initialization(prisma, projectId);
    const environment = await buildEnvironment(prisma, { projectId, isPrimary: true });
    environmentId = environment.id;
    environmentToken = environment.token;

    const flowContent = await buildContent(prisma, {
      projectId,
      environmentId,
      name: 'ws-cross-socket-flow',
      type: 'flow',
    });
    flowContentId = flowContent.id;
    const flowVersion = await buildVersion(prisma, {
      contentId: flowContent.id,
      sequence: 1,
      config: hideOnCheckoutConfig(),
      data: [],
    });
    await buildStep(prisma, {
      versionId: flowVersion.id,
      sequence: 0,
      name: 'Cross Socket Step',
      data: [],
    });
    await publishVersion(prisma, {
      environmentId,
      contentId: flowContent.id,
      versionId: flowVersion.id,
    });

    const bannerContent = await buildContent(prisma, {
      projectId,
      environmentId,
      name: 'ws-cross-socket-banner',
      type: 'banner',
    });
    bannerContentId = bannerContent.id;
    const bannerVersion = await buildVersion(prisma, {
      contentId: bannerContent.id,
      sequence: 1,
      config: hideOnCheckoutConfig(),
      data: {
        embedPlacement: 'top-of-page',
        overlayEmbedOverAppContent: false,
        stickToTopOfViewport: true,
        allowUsersToDismissEmbed: true,
        animateWhenEmbedAppears: false,
        contents: [],
      },
    });
    await publishVersion(prisma, {
      environmentId,
      contentId: bannerContent.id,
      versionId: bannerVersion.id,
    });
  }, 60000);

  afterAll(async () => {
    for (const client of openClients) {
      client.disconnect();
    }
    if (prisma) {
      await teardownProject(prisma, projectId);
    }
    await harness?.close();
  });

  it('does not activate a flow on another socket whose hide rules exclude its page', async () => {
    const hiddenTab = await connectOnPage(HIDDEN_PAGE);
    const startingTab = await connectOnPage(ALLOWED_PAGE);

    const ack = await startingTab.sendClientMessage(ClientMessageKind.START_CONTENT, {
      contentId: flowContentId,
      startReason: 'start_from_manual',
    });
    expect(ack).toBe(true);

    // The originating tab is on an allowed page, so it receives the session.
    await startingTab.waitForServerMessage(ServerMessageKind.SET_FLOW_SESSION);

    // The tab sitting on the excluded page must not be pushed the session.
    await expect(
      hiddenTab.waitForServerMessage(ServerMessageKind.SET_FLOW_SESSION, 1500),
    ).rejects.toThrow(/Timed out/);
  });

  it('still activates a flow on another socket whose page is allowed', async () => {
    const otherAllowedTab = await connectOnPage(OTHER_ALLOWED_PAGE);
    const startingTab = await connectOnPage(ALLOWED_PAGE);

    const ack = await startingTab.sendClientMessage(ClientMessageKind.START_CONTENT, {
      contentId: flowContentId,
      startReason: 'start_from_manual',
    });
    expect(ack).toBe(true);

    // Cross-tab sync within allowed pages is intended behaviour and must keep working.
    await expect(
      otherAllowedTab.waitForServerMessage(ServerMessageKind.SET_FLOW_SESSION),
    ).resolves.toMatchObject({ kind: ServerMessageKind.SET_FLOW_SESSION });
  });

  it('does not activate a banner on another socket whose hide rules exclude its page', async () => {
    const hiddenTab = await connectOnPage(HIDDEN_PAGE);
    const startingTab = await connectOnPage(ALLOWED_PAGE);

    const ack = await startingTab.sendClientMessage(ClientMessageKind.START_CONTENT, {
      contentId: bannerContentId,
      startReason: 'start_from_manual',
    });
    expect(ack).toBe(true);
    await startingTab.waitForServerMessage(ServerMessageKind.SET_BANNER_SESSION);

    await expect(
      hiddenTab.waitForServerMessage(ServerMessageKind.SET_BANNER_SESSION, 1500),
    ).rejects.toThrow(/Timed out/);
  });
});
