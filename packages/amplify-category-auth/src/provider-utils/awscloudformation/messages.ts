import chalk from 'chalk';

export const importMessages = {
  NoPoolsInRegion: (region: string) => `No Cognito User Pools were found in the configured region: ${region}.`,
  OnePoolNotValid: (userPoolId: string) =>
    `'There was only 1 Cognito User Pool (${userPoolId}) found, but it does not meet the requirements for import:`,
  MultipleAppClients: (type: 'Web' | 'Native') => `The User Pool has multiple ${type} Application Clients configured.`,
  SingleAppClientSelected: (type: 'Web' | 'Native', appClientName: string) =>
    `${greenCheck} Only one ${type} Application Client found: '${appClientName}' was automatically selected.`,
  NoOAuthConfigurationOnAppClients: () => `${greenCheck} Federated identity providers are not configured, no OAuth configuration needed.`,
  UserPoolOnlySuccess: (userPoolName: string) => `✅ Cognito User Pool '${userPoolName}' was successfully imported.`,

  Questions: {
    UserPoolSelection: 'Select the User Pool you want to import:',
    AutoCompleteFooter: '(Type in a partial name or scroll up and down to reveal more choices)',
    AppClientValidation: `The selected Cognito User Pool does not have at least 1 web and 1 native application client configured.`,
    SelectAppClient: (type: 'Web' | 'Native') => `Select a ${type} client to import:`,
    SelectOAuthProviders: 'Import the following identity providers from your User Pool:',
  },

  OAuth: {
    NoCommonProvidersFound: 'There are no common OAuth providers for the selected Application Clients.',
    SelectNewAppClients: 'Select new Application Clients',
    SomePropertiesAreNotMatching: 'The following OAuth properties are not matching:',
    ConfiguredIdentityProviders: 'Configured Identity Providers:',
    OAuthFlowEnabledForApplicationClient: 'OAuth Flow Enabled for Application Client:',
    CallbackURLs: 'Callback URLs:',
    LogoutURLs: 'Logout URLs:',
    AllowedOAuthFlows: 'Allowed OAuth Flows:',
    AllowedOAuthScopes: 'Allowed OAuth Scopes:',
  },
};

const greenCheck = chalk.green('✔');
