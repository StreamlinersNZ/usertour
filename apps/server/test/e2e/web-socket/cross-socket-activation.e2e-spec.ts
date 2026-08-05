import { PrismaService } from 'nestjs-prisma';
import { ClientMessageKind, RulesType, ServerMessageKind } from '@usertour/types';

import { initialization } from '@/common/initialization/initialization';
import {
  buildAttribute,
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
 *
 * Show-only content (banners) has no hide rules to author, so its visibility
 * rests on its show rules holding on the current page — the fan-out gates on
 * those instead. Flows deliberately keep the looser hide-rules-only gate,
 * because a multi-page flow continues onto pages its start rules never matched.
 *
 * A socket's company is part of that per-socket context too. Company-scoped
 * conditions evaluate to false when the receiving socket's company cannot be
 * resolved — no company yet, or no membership binding the user to the one it
 * names — and read as a hide rule that false means "do not hide". The fan-out
 * must therefore treat an unresolvable company as a reason to skip, not as
 * permission to deliver; the tab re-evaluates for itself on its next message.
 */
describe('WebSocket v2 cross-socket activation honours per-socket page conditions (e2e)', () => {
  let harness: WebSocketTestApp;
  let prisma: PrismaService;
  let projectId: string;
  let environmentId: string;
  let environmentToken: string;

  const externalUserId = `ws-cross-socket-user-${Date.now()}`;
  const chpExternalCompanyId = `ws-cross-socket-chp-${Date.now()}`;
  const hhpExternalCompanyId = `ws-cross-socket-hhp-${Date.now()}`;

  const ALLOWED_PAGE = 'https://example.test/app';
  const OTHER_ALLOWED_PAGE = 'https://example.test/dashboard';
  const HIDDEN_PAGE = 'https://example.test/checkout';

  let flowContentId: string;
  let bannerContentId: string;
  let showRulesBannerContentId: string;
  let showRulesFlowContentId: string;
  let companyHideRulesFlowContentId: string;

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
   * The SDK's group() call: binds this socket to a company and upserts the
   * company's attributes plus the user's membership in it. A socket that never
   * sends it has no company at all — the state every connection starts in.
   */
  const groupTo = async (
    client: WebSocketTestClient,
    externalCompanyId: string,
    publicationCode: string,
  ) => {
    const ack = await client.sendClientMessage(ClientMessageKind.UPSERT_COMPANY, {
      externalUserId,
      externalCompanyId,
      attributes: { publicationCode },
      membership: {},
    });
    expect(ack).toBe(true);
  };

  /** Remove the user's membership in a company, leaving the BizUser in place. */
  const severMembership = (externalCompanyId: string) =>
    prisma.bizUserOnCompany.deleteMany({
      where: {
        bizUser: { externalId: externalUserId, environmentId },
        bizCompany: { externalId: externalCompanyId, environmentId },
      },
    });

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

  /**
   * "Show only on the app pages" — the condition activates on ALLOWED_PAGE and
   * OTHER_ALLOWED_PAGE, never on HIDDEN_PAGE. Carries no hide rules, so a page
   * is excluded solely by failing to satisfy the show rules.
   */
  const showOnAppPagesConfig = () => ({
    enabledAutoStartRules: true,
    enabledHideRules: false,
    autoStartRules: [
      {
        id: 'show-on-app-pages',
        type: RulesType.CURRENT_PAGE,
        operators: 'and' as const,
        data: { includes: ['**/app**', '**/dashboard**'], excludes: [] },
      },
    ],
    hideRules: [],
    autoStartRulesSetting: {},
    hideRulesSetting: {},
  });

  /**
   * "Hide anywhere but the chp publication" — the condition activates (and
   * therefore hides) for every company whose publicationCode is something
   * else, and carries no page rules, so the only thing gating delivery is the
   * receiving socket's company.
   */
  const hideOutsideChpConfig = (attrId: string) => ({
    enabledAutoStartRules: false,
    enabledHideRules: true,
    autoStartRules: [],
    hideRules: [
      {
        id: 'hide-outside-chp',
        type: RulesType.USER_ATTR,
        operators: 'and' as const,
        data: { attrId, logic: 'not', value: 'chp' },
      },
    ],
    autoStartRulesSetting: {},
    hideRulesSetting: {},
  });

  const bannerData = () => ({
    embedPlacement: 'top-of-page',
    overlayEmbedOverAppContent: false,
    stickToTopOfViewport: true,
    allowUsersToDismissEmbed: true,
    animateWhenEmbedAppears: false,
    contents: [],
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
      data: bannerData(),
    });
    await publishVersion(prisma, {
      environmentId,
      contentId: bannerContent.id,
      versionId: bannerVersion.id,
    });

    const showRulesBannerContent = await buildContent(prisma, {
      projectId,
      environmentId,
      name: 'ws-cross-socket-show-rules-banner',
      type: 'banner',
    });
    showRulesBannerContentId = showRulesBannerContent.id;
    const showRulesBannerVersion = await buildVersion(prisma, {
      contentId: showRulesBannerContent.id,
      sequence: 1,
      config: showOnAppPagesConfig(),
      data: bannerData(),
    });
    await publishVersion(prisma, {
      environmentId,
      contentId: showRulesBannerContent.id,
      versionId: showRulesBannerVersion.id,
    });

    // Same show-rules config on a flow, to pin the content-type asymmetry.
    const showRulesFlowContent = await buildContent(prisma, {
      projectId,
      environmentId,
      name: 'ws-cross-socket-show-rules-flow',
      type: 'flow',
    });
    showRulesFlowContentId = showRulesFlowContent.id;
    const showRulesFlowVersion = await buildVersion(prisma, {
      contentId: showRulesFlowContent.id,
      sequence: 1,
      config: showOnAppPagesConfig(),
      data: [],
    });
    await buildStep(prisma, {
      versionId: showRulesFlowVersion.id,
      sequence: 0,
      name: 'Show Rules Flow Step',
      data: [],
    });
    await publishVersion(prisma, {
      environmentId,
      contentId: showRulesFlowContent.id,
      versionId: showRulesFlowVersion.id,
    });

    // Created before the first connection: the project's attribute list is
    // cached on first evaluation, so an attribute added later is invisible to
    // condition evaluation for the rest of the suite.
    const publicationCodeAttribute = await buildAttribute(prisma, {
      projectId,
      codeName: 'publicationCode',
      displayName: 'Publication Code',
      bizType: 2,
      dataType: 2,
    });

    const companyHideRulesFlowContent = await buildContent(prisma, {
      projectId,
      environmentId,
      name: 'ws-cross-socket-company-hide-rules-flow',
      type: 'flow',
    });
    companyHideRulesFlowContentId = companyHideRulesFlowContent.id;
    const companyHideRulesFlowVersion = await buildVersion(prisma, {
      contentId: companyHideRulesFlowContent.id,
      sequence: 1,
      config: hideOutsideChpConfig(publicationCodeAttribute.id),
      data: [],
    });
    await buildStep(prisma, {
      versionId: companyHideRulesFlowVersion.id,
      sequence: 0,
      name: 'Company Hide Rules Flow Step',
      data: [],
    });
    await publishVersion(prisma, {
      environmentId,
      contentId: companyHideRulesFlowContent.id,
      versionId: companyHideRulesFlowVersion.id,
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

  it('does not activate a banner on another socket whose show rules do not match its page', async () => {
    const hiddenTab = await connectOnPage(HIDDEN_PAGE);
    const startingTab = await connectOnPage(ALLOWED_PAGE);

    const ack = await startingTab.sendClientMessage(ClientMessageKind.START_CONTENT, {
      contentId: showRulesBannerContentId,
      startReason: 'start_from_manual',
    });
    expect(ack).toBe(true);
    await startingTab.waitForServerMessage(ServerMessageKind.SET_BANNER_SESSION);

    // A banner is only ever visible while its show rules hold, so a tab those
    // rules do not reach must not be pushed the session.
    await expect(
      hiddenTab.waitForServerMessage(ServerMessageKind.SET_BANNER_SESSION, 1500),
    ).rejects.toThrow(/Timed out/);
  });

  it('still activates a banner on another socket whose page matches its show rules', async () => {
    const otherAllowedTab = await connectOnPage(OTHER_ALLOWED_PAGE);
    const startingTab = await connectOnPage(ALLOWED_PAGE);

    const ack = await startingTab.sendClientMessage(ClientMessageKind.START_CONTENT, {
      contentId: showRulesBannerContentId,
      startReason: 'start_from_manual',
    });
    expect(ack).toBe(true);

    await expect(
      otherAllowedTab.waitForServerMessage(ServerMessageKind.SET_BANNER_SESSION),
    ).resolves.toMatchObject({ kind: ServerMessageKind.SET_BANNER_SESSION });
  });

  // Characterisation test: pins the deliberate asymmetry between content types.
  // Flows are gated on hide rules only, so unmatched start rules do not block
  // the fan-out. Passes with or without the show-only gate; it fails if a future
  // change extends that gate to every content type.
  it('still activates a flow on another socket whose page does not match its start rules', async () => {
    const hiddenTab = await connectOnPage(HIDDEN_PAGE);
    const startingTab = await connectOnPage(ALLOWED_PAGE);

    const ack = await startingTab.sendClientMessage(ClientMessageKind.START_CONTENT, {
      contentId: showRulesFlowContentId,
      startReason: 'start_from_manual',
    });
    expect(ack).toBe(true);

    // Multi-page flows legitimately continue onto pages their start rules never
    // matched, so the tab on the unmatched page still receives the session.
    await expect(
      hiddenTab.waitForServerMessage(ServerMessageKind.SET_FLOW_SESSION),
    ).resolves.toMatchObject({ kind: ServerMessageKind.SET_FLOW_SESSION });
  });

  it('does not activate a flow on another socket whose company fails its hide rules', async () => {
    const hhpTab = await connectOnPage(ALLOWED_PAGE);
    await groupTo(hhpTab, hhpExternalCompanyId, 'hhp');
    const startingTab = await connectOnPage(ALLOWED_PAGE);
    await groupTo(startingTab, chpExternalCompanyId, 'chp');

    const ack = await startingTab.sendClientMessage(ClientMessageKind.START_CONTENT, {
      contentId: companyHideRulesFlowContentId,
      startReason: 'start_from_manual',
    });
    expect(ack).toBe(true);

    // The originating tab is in the chp company, which the hide rules allow.
    await startingTab.waitForServerMessage(ServerMessageKind.SET_FLOW_SESSION);

    // The tab in another publication's company must not be pushed the session.
    await expect(
      hhpTab.waitForServerMessage(ServerMessageKind.SET_FLOW_SESSION, 1500),
    ).rejects.toThrow(/Timed out/);
  });

  it('does not activate a flow with company-scoped hide rules on a socket with no company', async () => {
    // A tab between identify() and group() — and any site whose group() call
    // fails — has no company for the hide rules to be judged against.
    const noCompanyTab = await connectOnPage(ALLOWED_PAGE);
    const startingTab = await connectOnPage(ALLOWED_PAGE);
    await groupTo(startingTab, chpExternalCompanyId, 'chp');

    const ack = await startingTab.sendClientMessage(ClientMessageKind.START_CONTENT, {
      contentId: companyHideRulesFlowContentId,
      startReason: 'start_from_manual',
    });
    expect(ack).toBe(true);
    await startingTab.waitForServerMessage(ServerMessageKind.SET_FLOW_SESSION);

    await expect(
      noCompanyTab.waitForServerMessage(ServerMessageKind.SET_FLOW_SESSION, 1500),
    ).rejects.toThrow(/Timed out/);
  });

  it('does not activate a flow with company-scoped hide rules on a socket whose membership is gone', async () => {
    const severedTab = await connectOnPage(ALLOWED_PAGE);
    await groupTo(severedTab, hhpExternalCompanyId, 'hhp');
    const startingTab = await connectOnPage(ALLOWED_PAGE);
    await groupTo(startingTab, chpExternalCompanyId, 'chp');

    // A tab left open across an admin-side deletion still names its company but
    // no longer has a membership resolving it, so its company attributes are
    // unreadable even though the company row exists.
    await severMembership(hhpExternalCompanyId);

    const ack = await startingTab.sendClientMessage(ClientMessageKind.START_CONTENT, {
      contentId: companyHideRulesFlowContentId,
      startReason: 'start_from_manual',
    });
    expect(ack).toBe(true);
    await startingTab.waitForServerMessage(ServerMessageKind.SET_FLOW_SESSION);

    await expect(
      severedTab.waitForServerMessage(ServerMessageKind.SET_FLOW_SESSION, 1500),
    ).rejects.toThrow(/Timed out/);
  });

  // Company context only gates the fan-out for hide rules that ask about it.
  // Content whose hide rules are page-based stays deliverable to sockets with
  // no company — the state every socket on a site that never calls group() is
  // permanently in.
  it('still activates a flow whose hide rules ignore company on a socket with no company', async () => {
    const noCompanyTab = await connectOnPage(OTHER_ALLOWED_PAGE);
    const startingTab = await connectOnPage(ALLOWED_PAGE);
    await groupTo(startingTab, chpExternalCompanyId, 'chp');

    const ack = await startingTab.sendClientMessage(ClientMessageKind.START_CONTENT, {
      contentId: flowContentId,
      startReason: 'start_from_manual',
    });
    expect(ack).toBe(true);

    await expect(
      noCompanyTab.waitForServerMessage(ServerMessageKind.SET_FLOW_SESSION),
    ).resolves.toMatchObject({ kind: ServerMessageKind.SET_FLOW_SESSION });
  });
});
