import userEvent from "@testing-library/user-event";

import {
  setupPropertiesEndpoints,
  setupSettingsEndpoints,
} from "__support__/server-mocks";
import { mockSettings } from "__support__/settings";
import { screen, within } from "__support__/ui";
import * as IsLocalhostModule from "embedding-sdk/lib/is-localhost";
import { renderWithSDKProviders } from "embedding-sdk/test/__support__/ui";
import {
  createMockApiKeyConfig,
  createMockAuthProviderUriConfig,
} from "embedding-sdk/test/mocks/config";
import { createMockSdkState } from "embedding-sdk/test/mocks/state";
import type { MetabaseAuthConfig } from "embedding-sdk/types";
import {
  createMockSettings,
  createMockTokenFeatures,
  createMockUser,
} from "metabase-types/api/mocks";
import { createMockState } from "metabase-types/store/mocks";

const TEST_USER = createMockUser();

jest.mock("metabase/visualizations/register", () => jest.fn(() => {}));

interface Options {
  authConfig: MetabaseAuthConfig;
  hasEmbeddingFeature?: boolean;
  isEmbeddingSdkEnabled?: boolean;
  isDevelopmentMode?: boolean;
}

const setup = (options: Options) => {
  const tokenFeatures = createMockTokenFeatures({
    embedding_sdk: options.hasEmbeddingFeature ?? true,
    "development-mode": options.isDevelopmentMode ?? false,
  });

  const settingValues = createMockSettings({
    "token-features": tokenFeatures,
    "enable-embedding-sdk": options.isEmbeddingSdkEnabled ?? true,
  });

  const state = createMockState({
    settings: mockSettings(settingValues),
    currentUser: TEST_USER,
    sdk: createMockSdkState(),
  });

  setupSettingsEndpoints([]);
  setupPropertiesEndpoints(settingValues);

  return renderWithSDKProviders(<div>hello!</div>, {
    sdkProviderProps: { authConfig: options.authConfig },
    storeInitialState: state,
  });
};

const PROBLEM_CARD_TEST_ID = "sdk-usage-problem-card";
const PROBLEM_INDICATOR_TEST_ID = "sdk-usage-problem-indicator";

describe("SdkUsageProblemDisplay", () => {
  it("does not show an error when JWT is provided with a license", () => {
    setup({
      authConfig: createMockAuthProviderUriConfig(),
      hasEmbeddingFeature: true,
    });

    expect(
      screen.queryByTestId(PROBLEM_INDICATOR_TEST_ID),
    ).not.toBeInTheDocument();
  });

  it("shows an error when JWT is used without a license", async () => {
    setup({
      authConfig: createMockAuthProviderUriConfig(),
      hasEmbeddingFeature: false,
    });

    await userEvent.click(screen.getByTestId(PROBLEM_INDICATOR_TEST_ID));

    const card = screen.getByTestId(PROBLEM_CARD_TEST_ID);
    expect(within(card).getByText("Error")).toBeInTheDocument();

    expect(
      within(card).getByText(
        /Attempting to use this in other ways is in breach of our usage policy/,
      ),
    ).toBeInTheDocument();

    const docsLink = within(card).getByRole("link", {
      name: /Documentation/,
    });

    expect(docsLink).toHaveAttribute(
      "href",
      "https://www.metabase.com/upgrade",
    );
  });

  it("shows a warning when API keys are used in localhost", async () => {
    expect(window.location.origin).toBe("http://localhost");

    setup({ authConfig: createMockApiKeyConfig(), hasEmbeddingFeature: true });

    await userEvent.click(screen.getByTestId(PROBLEM_INDICATOR_TEST_ID));

    const card = screen.getByTestId(PROBLEM_CARD_TEST_ID);

    expect(
      within(card).getByText("This embed is powered by the Metabase SDK."),
    ).toBeInTheDocument();

    expect(
      within(card).getByText(
        /This is intended for evaluation purposes and works only on localhost. To use on other sites, implement SSO./,
      ),
    ).toBeInTheDocument();

    const docsLink = within(card).getByRole("link", {
      name: /Documentation/,
    });

    expect(docsLink).toHaveAttribute(
      "href",
      "https://www.metabase.com/docs/latest/embedding/sdk/authentication#authenticating-people-from-your-server",
    );
  });

  it("shows an error when API keys are used in production", async () => {
    const mock = jest
      .spyOn(IsLocalhostModule, "getIsLocalhost")
      .mockImplementation(() => false);

    setup({
      authConfig: createMockApiKeyConfig(),
      hasEmbeddingFeature: true,
    });

    await userEvent.click(screen.getByTestId(PROBLEM_INDICATOR_TEST_ID));

    const card = screen.getByTestId(PROBLEM_CARD_TEST_ID);
    expect(within(card).getByText("Error")).toBeInTheDocument();

    expect(
      within(card).getByText(
        /This is intended for evaluation purposes and works only on localhost. To use on other sites, implement SSO./,
      ),
    ).toBeInTheDocument();

    mock.mockRestore();
  });

  it("shows an error when neither an Auth Provider URI or API keys are provided", async () => {
    setup({
      // @ts-expect-error - we're intentionally passing neither to simulate bad usage
      authConfig: { metabaseInstanceUrl: "http://localhost" },
    });

    await userEvent.click(screen.getByTestId(PROBLEM_INDICATOR_TEST_ID));

    const card = screen.getByTestId(PROBLEM_CARD_TEST_ID);

    expect(
      within(card).getByText(
        /must provide either an Auth Provider URI or an API key for authentication/,
      ),
    ).toBeInTheDocument();

    const docsLink = within(card).getByRole("link", {
      name: /Documentation/,
    });

    expect(docsLink).toHaveAttribute(
      "href",
      "https://www.metabase.com/docs/latest/embedding/sdk/authentication#authenticating-people-from-your-server",
    );
  });

  it("shows an error when both an Auth Provider URI and API keys are provided", async () => {
    setup({
      // @ts-expect-error - we're intentionally passing both to simulate bad usage
      authConfig: {
        apiKey: "TEST_API_KEY",
        metabaseInstanceUrl: "http://localhost",
        authProviderUri: "http://TEST_URI/sso/metabase",
      },
    });

    await userEvent.click(screen.getByTestId(PROBLEM_INDICATOR_TEST_ID));

    const card = screen.getByTestId(PROBLEM_CARD_TEST_ID);

    expect(
      within(card).getByText(
        /cannot use both an Auth Provider URI and API key authentication at the same time/,
      ),
    ).toBeInTheDocument();

    const docsLink = within(card).getByRole("link", {
      name: /Documentation/,
    });

    expect(docsLink).toHaveAttribute(
      "href",
      "https://www.metabase.com/docs/latest/embedding/sdk/authentication#authenticating-people-from-your-server",
    );
  });

  // Caveat: we cannot detect this on non-localhost environments, as
  // CORS is disabled on /api/session/properties.
  it("shows an error when Embedding SDK is disabled on localhost", async () => {
    setup({
      authConfig: createMockAuthProviderUriConfig(),
      hasEmbeddingFeature: true,
      isEmbeddingSdkEnabled: false,
    });

    await userEvent.click(screen.getByTestId(PROBLEM_INDICATOR_TEST_ID));

    const card = screen.getByTestId(PROBLEM_CARD_TEST_ID);

    expect(
      within(card).getByText(
        /The embedding SDK is not enabled for this instance. Please enable it in settings to start using the SDK./,
      ),
    ).toBeInTheDocument();

    const docsLink = within(card).getByRole("link", {
      name: /Documentation/,
    });

    expect(docsLink).toHaveAttribute(
      "href",
      "https://www.metabase.com/docs/latest/embedding/sdk/introduction#in-metabase",
    );
  });

  it("shows a warning when development mode is enabled", async () => {
    setup({
      authConfig: createMockAuthProviderUriConfig(),
      isEmbeddingSdkEnabled: true,
      isDevelopmentMode: true,
    });

    await userEvent.click(screen.getByTestId(PROBLEM_INDICATOR_TEST_ID));

    const card = screen.getByTestId(PROBLEM_CARD_TEST_ID);

    expect(
      within(card).getByText("This embed is powered by the Metabase SDK."),
    ).toBeInTheDocument();

    expect(
      within(card).getByText(
        "This Metabase is in development mode intended exclusively for testing. Using this Metabase for everyday BI work or when embedding in production is considered unfair usage.",
      ),
    ).toBeInTheDocument();

    const docsLink = within(card).getByRole("link", {
      name: /Documentation/,
    });

    expect(docsLink).toHaveAttribute(
      "href",
      "https://www.metabase.com/upgrade",
    );
  });
});
