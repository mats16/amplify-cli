import {
  GetUserPoolMfaConfigResponse,
  IdentityProviderType,
  UserPoolClientType,
  UserPoolType,
} from 'aws-sdk/clients/cognitoidentityserviceprovider';
import Enquirer from 'enquirer';
import _ from 'lodash';
import uuid from 'uuid';
import { $TSContext, $TSObject, ServiceSelection, stateManager } from 'amplify-cli-core';
import { ICognitoUserPoolService, IIdentityPoolService } from 'amplify-util-import';
import { importMessages } from './messages';

// Currently the CLI only supports the output generation of these providers
const supportedIdentityProviders = ['COGNITO', 'Facebook', 'Google', 'LoginWithAmazon'];

type AuthSelections = 'userPoolOnly' | 'identityPoolAndUserPool';

type ImportAnswers = {
  authSelections?: AuthSelections;
  resourceName?: string;
  userPoolId?: string;
  userPool?: UserPoolType;
  appClientWebId?: string; // We need this member only to have a slot for this to fill by enquirer after answer, it is reset after appClientWeb is set
  appClientWeb?: UserPoolClientType;
  appClientNativeId?: string; // We need this member only to have a slot for this to fill by enquirer after answer, it is reset after appClientNative is set
  appClientNative?: UserPoolClientType;
  oauthProviders?: string[];
  oauthProperties?: OAuthProperties;
  mfaConfiguration?: GetUserPoolMfaConfigResponse;
  identityProviders?: IdentityProviderType[];
};

type UserPoolChoice = {
  message: string;
  value: string;
};

type Choices = [{ name?: string; value?: string; display?: string }];

type ImportParameters = {
  providerName: string;
  userPoolList: UserPoolChoice[];
  webClients?: UserPoolClientType[];
  nativeClients?: UserPoolClientType[];
  bothAppClientsWereAutoSelected?: boolean;
};

type OAuthResult = {
  isValid: boolean;
  oauthProviders?: string[];
  oauthProperties?: OAuthProperties;
};

type OAuthProperties = {
  callbackURLs?: string[];
  logoutURLs?: string[];
  allowedOAuthFlows?: string[];
  allowedOAuthScopes?: string[];
  allowedOAuthFlowsUserPoolClient?: boolean;
};

type PartialOutput = {
  UserPoolId: string;
  UserPoolName: string;
  AppClientID: string;
  AppClientIDWeb: string;
};

type PartialOutputProcessingResult = {
  succeeded: boolean;
  output?: $TSObject;
  hostedUIProviderCreds?: string;
};

interface ProviderUtils {
  createCognitoUserPoolService(context: $TSContext): Promise<ICognitoUserPoolService>;
  createIdentityPoolService(context: $TSContext): Promise<IIdentityPoolService>;
  saveResourceParameters(
    context: $TSContext,
    category: string,
    resourceName: string,
    privateParams: $TSObject,
    envSpecificParams: string[],
  ): void;
}

export const importResource = async (context: $TSContext, serviceSelection: ServiceSelection) => {
  // Load provider
  const providerPlugin = require(serviceSelection.provider);
  const providerUtils = providerPlugin as ProviderUtils;

  await importResourceCore(context, serviceSelection.providerName, providerUtils);
};

const importResourceCore = async (context: $TSContext, providerName: string, providerUtils: ProviderUtils) => {
  // const serviceMetadata = require('../supported-services').supportedServices[serviceSelection.service];
  // const { stringMapsFilename } = serviceMetadata;
  // const stringMapsSrc = `${__dirname}/assets/${stringMapsFilename}`;
  // const { hostedUIProviders } = require(stringMapsSrc) as { hostedUIProviders: Choices };

  const cognito = await providerUtils.createCognitoUserPoolService(context);
  const questionParameters: ImportParameters = await createParameters(cognito, providerName);

  // Return it no userpools found in the project's region
  if (_.isEmpty(questionParameters.userPoolList)) {
    const amplifyMeta = stateManager.getMeta();
    const { Region } = amplifyMeta.providers[providerName];

    context.print.info(importMessages.NoPoolsInRegion(Region));
    return;
  }

  const projectConfig = context.amplify.getProjectConfig();
  const [shortId] = uuid().split('-');
  const projectName = projectConfig.projectName.toLowerCase().replace(/[^A-Za-z0-9_]+/g, '_');

  const defaultAnswers: ImportAnswers = {
    authSelections: 'userPoolOnly',
    resourceName: `${projectName}${shortId}`,
  };

  const answers: ImportAnswers = { ...defaultAnswers };
  let importSucceeded = false; // We set this variable if app client selection goes right

  const enquirer = new Enquirer<ImportAnswers>(undefined, defaultAnswers);

  // User Pool selection

  // If there is 1 user pool only, before preselecting we have to validate it.
  if (questionParameters.userPoolList.length === 1) {
    const validationResult = await validateUserPool(
      context,
      cognito,
      questionParameters,
      answers,
      questionParameters.userPoolList[0].value,
    );

    if (typeof validationResult === 'string') {
      context.print.info(importMessages.OnePoolNotValid(questionParameters.userPoolList[0].value));
      context.print.error(validationResult);
      return;
    }

    answers.userPoolId = questionParameters.userPoolList[0].value;
    answers.userPool = await cognito.getUserPoolDetails(answers.userPoolId);
  } else {
    // If multiple pools found let the customer select one
    const userPoolQuestion = {
      type: 'autocomplete',
      name: 'userPoolId',
      message: importMessages.Questions.UserPoolSelection,
      required: true,
      choices: questionParameters.userPoolList,
      footer: importMessages.Questions.AutoCompleteFooter,
      async validate(value: string) {
        return await validateUserPool(context, cognito, questionParameters, answers, value);
      },
    };

    const { userPoolId } = await enquirer.prompt(userPoolQuestion as any); // any case needed because async validation TS definition is not up to date
    answers.userPoolId = userPoolId!;
    answers.userPool = await cognito.getUserPoolDetails(userPoolId!);
  }

  // We have to create a loop here, to handle OAuth configuration/misconfiguration nicely.
  // If the selected user pool has federation configured or the selected app clients are having Cognito federation enabled and
  // customer selects to import OAuth support, then selected app client settings must be matched. If the OAuth properties
  // are different we have to tell it to the customer and offer to select different app clients with matching properties.
  // NOTE: We are intentionally not matching app client properties upfront.
  let oauthLoopFinished = false;

  do {
    await selectAppClients(context, enquirer, questionParameters, answers);

    if (_.isEmpty(answers.appClientWeb?.SupportedIdentityProviders) && _.isEmpty(answers.appClientWeb?.SupportedIdentityProviders)) {
      context.print.info(importMessages.NoOAuthConfigurationOnAppClients());

      oauthLoopFinished = true;
      importSucceeded = true;
    } else {
      // Check OAuth config matching and enablement
      const oauthResult = await appClientsOAuthPropertiesMatching(context, answers.appClientWeb!, answers.appClientNative!);

      if (oauthResult.isValid) {
        // Store the results in the answer
        answers.oauthProviders = oauthResult.oauthProviders;
        answers.oauthProperties = oauthResult.oauthProperties;

        oauthLoopFinished = true;
        importSucceeded = true;
      } else {
        // If validation failed for some reason and both app clients were auto picked then exit the loop
        // to not to get into an infinite one.
        if (questionParameters.bothAppClientsWereAutoSelected) {
          oauthLoopFinished = true;
        } else {
          context.print.info(importMessages.OAuth.SelectNewAppClients);
        }

        // If app clients are not matching then we show a message and asking if customer wants to select
        // other client applications, if not, then we exit the loop and import is aborted.

        // reset values in answers
        answers.appClientWebId = undefined;
        answers.appClientWeb = undefined;
        answers.appClientNativeId = undefined;
        answers.appClientNative = undefined;
      }
    }
  } while (!oauthLoopFinished);

  // Return if the question loop was finished without successful selections.
  if (!importSucceeded) {
    return;
  }

  if (answers.userPool.MfaConfiguration !== 'OFF') {
    // Use try catch in case if there is no MFA configuration for the user pool
    try {
      answers.mfaConfiguration = await cognito.getUserPoolMfaConfig(answers.userPoolId);
    } catch {}
  }

  if (answers.oauthProviders && answers.oauthProviders.length > 0) {
    answers.identityProviders = await cognito.listUserPoolIdentityProviders(answers.userPoolId);
  }

  // Import questions succeeded, create the create the required CLI resource state from the answers.
  await updateStateFiles(context, questionParameters, answers);

  context.print.info('');
  context.print.info(importMessages.UserPoolOnlySuccess(answers.userPool.Name!));
  context.print.info('');
  context.print.info('Next steps:');
  context.print.info('');
  context.print.info("- This resource will be available for GraphQL APIs ('amplify add api')");
  context.print.info('- Use amplify libraries to add signup, signing, signout capabilities to your client');
  context.print.info('  application.');
  context.print.info('  - iOS: https://docs.amplify.aws/lib/auth/getting-started/q/platform/ios');
  context.print.info('  - Android: https://docs.amplify.aws/lib/auth/getting-started/q/platform/android');
  context.print.info('  - JavaScript: https://docs.amplify.aws/lib/auth/getting-started/q/platform/js');
};

const validateUserPool = async (
  context: $TSContext,
  cognito: ICognitoUserPoolService,
  parameters: ImportParameters,
  answers: ImportAnswers,
  userPoolId: string,
): Promise<boolean | string> => {
  const userPoolClients = await cognito.listUserPoolClients(userPoolId);
  const webClients = userPoolClients.filter(c => !c.ClientSecret);
  const nativeClients = userPoolClients.filter(c => c.ClientSecret !== undefined);

  // Check if the selected user pool has at least 1 native and 1 web app client configured.
  if (webClients?.length < 1 || nativeClients?.length < 1) {
    return `The selected Cognito User Pool does not have at least 1 web and 1 native application client configured.`;
  }

  // Save into parameters, further quesions are using it
  if (parameters.webClients?.length === 0) {
    parameters.webClients!.push(...(webClients || []));
  }
  if (parameters.nativeClients?.length === 0) {
    parameters.nativeClients!.push(...(nativeClients || []));
  }

  return true;
};

const selectAppClients = async (
  context: $TSContext,
  enquirer: Enquirer<ImportAnswers>,
  questionParameters: ImportParameters,
  answers: ImportAnswers,
): Promise<void> => {
  let autoSelected = 0;

  // Select web application clients
  if (questionParameters.webClients!.length === 1) {
    answers.appClientWeb = questionParameters.webClients![0];

    context.print.info(importMessages.SingleAppClientSelected('Web', answers.appClientWeb.ClientName!));

    autoSelected++;
  } else {
    const appClientChoices = questionParameters
      .webClients!.map(c => ({
        message: `${c.ClientName!} (${c.ClientId})`,
        value: c.ClientId,
      }))
      .sort((a, b) => a.message.localeCompare(b.message));

    const appClientSelectQuestion = {
      type: 'select',
      name: 'appClientWebId',
      message: importMessages.Questions.SelectAppClient('Web'),
      required: true,
      choices: appClientChoices,
    };

    context.print.info(importMessages.MultipleAppClients('Web'));

    const { appClientWebId } = await enquirer.prompt(appClientSelectQuestion);
    answers.appClientWeb = questionParameters.webClients!.find(c => c.ClientId! === appClientWebId);
    answers.appClientWebId = undefined; // Only to be used by enquirer
  }

  // Select Native application client
  if (questionParameters.nativeClients!.length === 1) {
    answers.appClientNative = questionParameters.nativeClients![0];

    context.print.info(importMessages.SingleAppClientSelected('Native', answers.appClientNative.ClientName!));

    autoSelected++;
  } else {
    const appClientChoices = questionParameters
      .nativeClients!.map(c => ({
        message: `${c.ClientName!} (${c.ClientId})`,
        value: c.ClientId,
      }))
      .sort((a, b) => a.message.localeCompare(b.message));

    const appClientSelectQuestion = {
      type: 'select',
      name: 'appClientNativeId',
      message: importMessages.Questions.SelectAppClient('Native'),
      required: true,
      choices: appClientChoices,
    };

    context.print.info(importMessages.MultipleAppClients('Native'));

    const { appClientNativeId } = await enquirer.prompt(appClientSelectQuestion);
    answers.appClientNative = questionParameters.nativeClients!.find(c => c.ClientId! === appClientNativeId);
    answers.appClientNativeId = undefined; // Only to be used by enquirer
  }

  questionParameters.bothAppClientsWereAutoSelected = autoSelected === 2;
};

const appClientsOAuthPropertiesMatching = async (
  context: $TSContext,
  appClientWeb: UserPoolClientType,
  appClientNative: UserPoolClientType,
): Promise<OAuthResult> => {
  // Here both clients having some federation configured, compare the OAuth specific properties,
  // since we can only import app clients with completely matching configuration, due
  // to how CLI and Client SDKs working now.

  // Compare the app client properties, they must match, otherwise show what is not matching. For convenience we show all the properties that are not matching,
  // not just the first mismatch.
  const callbackUrlMatching = isArraysEqual(appClientWeb.CallbackURLs!, appClientNative.CallbackURLs!);
  const logoutUrlsMatching = isArraysEqual(appClientWeb.LogoutURLs!, appClientNative.LogoutURLs!);
  const allowedOAuthFlowsMatching = isArraysEqual(appClientWeb.AllowedOAuthFlows!, appClientNative.AllowedOAuthFlows!);
  const allowedOAuthScopesMatching = isArraysEqual(appClientWeb.AllowedOAuthScopes!, appClientNative.AllowedOAuthScopes!);
  const allowedOAuthFlowsUserPoolClientMatching =
    appClientWeb.AllowedOAuthFlowsUserPoolClient === appClientNative.AllowedOAuthFlowsUserPoolClient;
  const supportedIdentityProvidersMatching = isArraysEqual(
    appClientWeb.SupportedIdentityProviders!,
    appClientNative.SupportedIdentityProviders!,
  );
  let propertiesMatching =
    supportedIdentityProvidersMatching &&
    callbackUrlMatching &&
    logoutUrlsMatching &&
    allowedOAuthFlowsMatching &&
    allowedOAuthScopesMatching &&
    allowedOAuthFlowsUserPoolClientMatching;

  if (!propertiesMatching) {
    context.print.error(importMessages.OAuth.SomePropertiesAreNotMatching);
    context.print.info('');

    if (!supportedIdentityProvidersMatching) {
      showValidationTable(
        context,
        importMessages.OAuth.ConfiguredIdentityProviders,
        appClientWeb,
        appClientNative,
        appClientWeb.SupportedIdentityProviders,
        appClientNative.SupportedIdentityProviders,
      );
    }

    if (!allowedOAuthFlowsUserPoolClientMatching) {
      showValidationTable(
        context,
        importMessages.OAuth.OAuthFlowEnabledForApplicationClient,
        appClientWeb,
        appClientNative,
        [appClientWeb.AllowedOAuthFlowsUserPoolClient?.toString() || ''],
        [appClientNative.AllowedOAuthFlowsUserPoolClient?.toString() || ''],
      );
    }

    if (!callbackUrlMatching) {
      showValidationTable(
        context,
        importMessages.OAuth.CallbackURLs,
        appClientWeb,
        appClientNative,
        appClientWeb.CallbackURLs,
        appClientNative.CallbackURLs,
      );
    }

    if (!logoutUrlsMatching) {
      showValidationTable(
        context,
        importMessages.OAuth.LogoutURLs,
        appClientWeb,
        appClientNative,
        appClientWeb.LogoutURLs,
        appClientNative.LogoutURLs,
      );
    }

    if (!allowedOAuthFlowsMatching) {
      showValidationTable(
        context,
        importMessages.OAuth.AllowedOAuthFlows,
        appClientWeb,
        appClientNative,
        appClientWeb.AllowedOAuthFlows,
        appClientNative.AllowedOAuthFlows,
      );
    }

    if (!allowedOAuthScopesMatching) {
      showValidationTable(
        context,
        importMessages.OAuth.AllowedOAuthScopes,
        appClientWeb,
        appClientNative,
        appClientWeb.AllowedOAuthScopes,
        appClientNative.AllowedOAuthScopes,
      );
    }

    return {
      isValid: false,
    };
  }

  // Don't return any OAuth properties if no OAuth providers were selected
  if (!appClientWeb.SupportedIdentityProviders || appClientWeb.SupportedIdentityProviders.length === 0) {
    return {
      isValid: true,
    };
  }

  const filteredProviders = appClientWeb.SupportedIdentityProviders!.filter(p => supportedIdentityProviders.includes(p));

  return {
    isValid: true,
    oauthProviders: filteredProviders || [],
    oauthProperties: {
      callbackURLs: appClientWeb.CallbackURLs,
      logoutURLs: appClientWeb.LogoutURLs,
      allowedOAuthFlows: appClientWeb.AllowedOAuthFlows,
      allowedOAuthScopes: appClientWeb.AllowedOAuthScopes,
      allowedOAuthFlowsUserPoolClient: appClientWeb.AllowedOAuthFlowsUserPoolClient,
    },
  };
};

const showValidationTable = (
  context: $TSContext,
  title: string,
  appClientWeb: UserPoolClientType,
  appClientNative: UserPoolClientType,
  webValues: string[] | undefined,
  nativeValues: string[] | undefined,
) => {
  const tableOptions = [[appClientWeb.ClientName!, appClientNative.ClientName!]];
  const webNames = [...(webValues || [])].sort();
  const nativeNames = [...(nativeValues || [])].sort();
  const rowsDiff = Math.abs(webNames.length - nativeNames.length);

  if (webNames.length < nativeNames.length) {
    webNames.push(..._.times(rowsDiff, () => ''));
  } else if (webNames.length > nativeNames.length) {
    nativeNames.push(..._.times(rowsDiff, () => ''));
  }

  // At this point both arrays are the same size
  for (let i = 0; i < webNames.length; i++) {
    tableOptions.push([webNames[i], nativeNames[i]]);
  }

  context.print.info(title);
  context.print.info('');
  context.print.table(tableOptions, { format: 'markdown' });
  context.print.info('');
};

const isArraysEqual = (left: string[], right: string[]): boolean => {
  const sortedLeft = [...(left || [])].sort();
  const sortedRight = [...(right || [])].sort();

  return _.isEqual(sortedLeft, sortedRight);
};

const updateStateFiles = async (context: $TSContext, parameters: ImportParameters, answers: ImportAnswers): Promise<void> => {
  const authResource: any = {
    service: 'Cognito',
    serviceType: 'imported',
    providerPlugin: parameters.providerName,
    dependsOn: [],
    customAuth: isCustomAuthConfigured(answers.userPool!),
  };

  const hasOAuthConfig =
    !!answers.oauthProviders &&
    answers.oauthProviders.length > 0 &&
    !!answers.oauthProperties &&
    !!answers.oauthProperties.allowedOAuthFlows &&
    answers.oauthProperties.allowedOAuthFlows.length > 0 &&
    !!answers.oauthProperties.allowedOAuthScopes &&
    answers.oauthProperties.allowedOAuthScopes.length > 0 &&
    !!answers.oauthProperties.callbackURLs &&
    answers.oauthProperties.callbackURLs.length > 0 &&
    !!answers.oauthProperties.logoutURLs &&
    answers.oauthProperties.logoutURLs.length > 0;

  // Add resource data to amplify-meta file and backend-config, since backend-config requires less information
  // we have to do a separate update to it without duplicating the methods
  const authResourceMeta = _.clone(authResource);
  authResourceMeta.output = createFullAuthOutputFromAnswers(context, parameters, answers, hasOAuthConfig);

  // In backend config we only store the selections, other information will be refreshed dynamically
  // during environment operations
  const authResourceBackendConfig = _.clone(authResource);
  authResourceBackendConfig.output = createReducedAuthOutputFromAnswers(context, parameters, answers);

  context.amplify.updateamplifyMetaAfterResourceAdd('auth', answers.resourceName!, authResourceMeta, authResourceBackendConfig);

  const envSpecificParams: $TSObject = {};

  // // Update team provider-info
  if (hasOAuthConfig) {
    const oauthCredentials = createOAuthCredentialsFromAnswers(context, parameters, answers);

    envSpecificParams.hostedUIProviderCreds = oauthCredentials;
  }

  context.amplify.saveEnvResourceParameters(context, 'auth', answers.resourceName!, envSpecificParams);
};

const createFullAuthOutputFromAnswers = (
  context: $TSContext,
  parameters: ImportParameters,
  answers: ImportAnswers,
  hasOAuthConfig: boolean,
): $TSObject => {
  const userPool = answers.userPool!;

  const output: $TSObject = {
    UserPoolId: userPool.Id!,
    UserPoolName: userPool.Name!,
    AppClientID: answers.appClientNative!.ClientId,
    AppClientSecret: answers.appClientNative!.ClientSecret,
    AppClientIDWeb: answers.appClientWeb!.ClientId,
    HostedUIDomain: userPool.Domain,
  };

  // SNS Role if there is SMS configuration on the user pool, use the separate MFA configuration object
  // not the one on the userPool itself
  if (userPool.MfaConfiguration !== 'OFF' && answers.mfaConfiguration?.SmsMfaConfiguration?.SmsConfiguration) {
    output.CreatedSNSRole = answers.mfaConfiguration.SmsMfaConfiguration.SmsConfiguration?.SnsCallerArn;
  }

  // Create OAuth configuration only if there are selected providers to import
  if (hasOAuthConfig) {
    const oauthMetadata = {
      AllowedOAuthFlows: answers.oauthProperties!.allowedOAuthFlows,
      AllowedOAuthScopes: answers.oauthProperties!.allowedOAuthScopes,
      CallbackURLs: answers.oauthProperties!.callbackURLs,
      LogoutURLs: answers.oauthProperties!.logoutURLs,
    };

    output.OAuthMetadata = JSON.stringify(oauthMetadata);
  }

  return output;
};

const createReducedAuthOutputFromAnswers = (context: $TSContext, parameters: ImportParameters, answers: ImportAnswers): $TSObject => {
  const userPool = answers.userPool!;

  const output: $TSObject = {
    UserPoolId: userPool.Id!,
    UserPoolName: userPool.Name!,
    AppClientID: answers.appClientNative!.ClientId,
    AppClientIDWeb: answers.appClientWeb!.ClientId,
  };

  return output;
};

const createOAuthCredentialsFromAnswers = (context: $TSContext, parameters: ImportParameters, answers: ImportAnswers): string => {
  const credentials = answers.identityProviders!.map(idp => ({
    ProviderName: idp.ProviderName!,
    client_id: idp.ProviderDetails?.client_id,
    client_secret: idp.ProviderDetails?.client_secret,
  }));

  return JSON.stringify(credentials);
};

export const createFullOutputFromPartialOutput = async (
  context: $TSContext,
  resourceName: string,
  resource: $TSObject,
  providerName: string,
  providerUtils: ProviderUtils,
): Promise<PartialOutputProcessingResult> => {
  const partialOutput: PartialOutput = resource.output;
  const cognito = await providerUtils.createCognitoUserPoolService(context);
  const questionParameters: ImportParameters = await createParameters(cognito, providerName);

  const defaultAnswers: ImportAnswers = {
    authSelections: 'userPoolOnly',
    resourceName,
  };

  const answers: ImportAnswers = { ...defaultAnswers };

  answers.userPoolId = partialOutput.UserPoolId;

  try {
    answers.userPool = await cognito.getUserPoolDetails(answers.userPoolId!);
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      context.print.error(importMessages.UserPoolNotFound(partialOutput.UserPoolName, partialOutput.UserPoolId));

      error.stack = undefined;
    }

    throw error;
  }

  const validationResult = await validateUserPool(context, cognito, questionParameters, answers, partialOutput.UserPoolId);

  if (typeof validationResult === 'string') {
    context.print.error(importMessages.UserPoolValidation(partialOutput.UserPoolName, partialOutput.UserPoolId));
    context.print.error(validationResult);

    return {
      succeeded: false,
    };
  }

  // Get app clients based on passed in previous values
  answers.appClientWeb = questionParameters.webClients!.find(c => c.ClientId! === partialOutput.AppClientIDWeb);

  if (!answers.appClientWeb) {
    context.print.info(importMessages.AppClientNotFound('Web', partialOutput.AppClientIDWeb));
    return {
      succeeded: false,
    };
  }

  answers.appClientNative = questionParameters.nativeClients!.find(c => c.ClientId! === partialOutput.AppClientID);

  if (!answers.appClientNative) {
    context.print.info(importMessages.AppClientNotFound('Native', partialOutput.AppClientID));
    return {
      succeeded: false,
    };
  }

  // Check OAuth config matching and enablement
  const oauthResult = await appClientsOAuthPropertiesMatching(context, answers.appClientWeb!, answers.appClientNative!);

  if (!oauthResult.isValid) {
    return {
      succeeded: false,
    };
  }

  // Store the results in the answer
  answers.oauthProviders = oauthResult.oauthProviders;
  answers.oauthProperties = oauthResult.oauthProperties;

  if (answers.oauthProviders && answers.oauthProviders.length > 0) {
    answers.identityProviders = await cognito.listUserPoolIdentityProviders(answers.userPoolId!);
  }

  const hasOAuthConfig =
    !!answers.oauthProviders &&
    answers.oauthProviders.length > 0 &&
    !!answers.oauthProperties &&
    !!answers.oauthProperties.allowedOAuthFlows &&
    answers.oauthProperties.allowedOAuthFlows.length > 0 &&
    !!answers.oauthProperties.allowedOAuthScopes &&
    answers.oauthProperties.allowedOAuthScopes.length > 0 &&
    !!answers.oauthProperties.callbackURLs &&
    answers.oauthProperties.callbackURLs.length > 0 &&
    !!answers.oauthProperties.logoutURLs &&
    answers.oauthProperties.logoutURLs.length > 0;

  // Add resource data to amplify-meta file and backend-config, since backend-config requires less information
  // we have to do a separate update to it without duplicating the methods
  const output = createFullAuthOutputFromAnswers(context, questionParameters, answers, hasOAuthConfig);
  let hostedUIProviderCreds;

  // Data for team provider-info
  if (hasOAuthConfig) {
    hostedUIProviderCreds = createOAuthCredentialsFromAnswers(context, questionParameters, answers);
  }

  return {
    succeeded: true,
    output,
    hostedUIProviderCreds,
  };
};

const createParameters = async (cognito: ICognitoUserPoolService, providerName: string): Promise<ImportParameters> => {
  // Get list of user pools to see if there is anything to import
  const userPoolList = await cognito.listUserPools();

  const questionParameters: ImportParameters = {
    providerName,
    userPoolList: userPoolList
      .map(up => ({
        message: `${up.Name} (${up.Id})`,
        value: up.Id!,
      }))
      .sort((a, b) => a.message.localeCompare(b.message)),
    webClients: [],
    nativeClients: [],
  };

  return questionParameters;
};

const isCustomAuthConfigured = (userPool: UserPoolType): boolean => {
  const customAuthConfigured =
    !!userPool &&
    !!userPool.LambdaConfig &&
    !!userPool.LambdaConfig.DefineAuthChallenge &&
    userPool.LambdaConfig.DefineAuthChallenge.length > 0 &&
    !!userPool.LambdaConfig.CreateAuthChallenge &&
    userPool.LambdaConfig.CreateAuthChallenge.length > 0 &&
    !!userPool.LambdaConfig.VerifyAuthChallengeResponse &&
    userPool.LambdaConfig.VerifyAuthChallengeResponse.length > 0;

  return customAuthConfigured;
};
