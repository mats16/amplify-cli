import { UserPoolClientType, UserPoolType } from 'aws-sdk/clients/cognitoidentityserviceprovider';
import Enquirer from 'enquirer';
import _ from 'lodash';
import uuid from 'uuid';
import { $TSContext, ServiceSelection, stateManager, validate } from 'amplify-cli-core';
import { ICognitoUserPoolService, IIdentityPoolService } from 'amplify-util-import';
import { importMessages } from './messages';

type AuthSelections = 'userPoolOnly' | 'identityPoolAndUserPool';

type ImportAnswers = {
  authSelections?: AuthSelections;
  resourceName?: string;
  userPoolId?: string;
  userPool?: UserPoolType;
  appClientWebId?: string;
  appClientWeb?: UserPoolClientType;
  appClientNativeId?: string;
  appClientNative?: UserPoolClientType;
  oauthProviders?: string[];
  oauthProperties?: OAuthProperties;
};

type UserPoolChoice = {
  message: string;
  value: string;
};

type ImportParameters = {
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

interface ProviderUtils {
  createCognitoUserPoolService(context: $TSContext): Promise<ICognitoUserPoolService>;
  createIdentityPoolService(context: $TSContext): Promise<IIdentityPoolService>;
}

export const importResource = async (context: $TSContext, serviceSelection: ServiceSelection) => {
  //const serviceMetadata = require('../supported-services').supportedServices[serviceSelection.service];
  //const { defaultValuesFilename, stringMapFilename, serviceWalkthroughFilename } = serviceMetadata;

  // Load provider and retrieve current region from meta
  const provider = require(serviceSelection.provider);
  const providerUtils = provider as ProviderUtils;
  const amplifyMeta = stateManager.getMeta();
  const projectConfig = context.amplify.getProjectConfig();
  const projectType = projectConfig.frontend;
  const { Region: region } = amplifyMeta.providers[serviceSelection.providerName];
  const [shortId] = uuid().split('-');
  const projectName = projectConfig.projectName.toLowerCase().replace(/[^A-Za-z0-9_]+/g, '_');

  const cognito = await providerUtils.createCognitoUserPoolService(context);

  // Get list of user pools to see if there is anything to import
  const userPoolList = await cognito.listUserPools();

  const userPoolChoices: UserPoolChoice[] = userPoolList
    .map(up => ({
      message: `${up.Name} (${up.Id})`,
      value: up.Id!,
    }))
    .sort((a, b) => a.message.localeCompare(b.message));

  if (_.isEmpty(userPoolList)) {
    context.print.info(importMessages.NoPoolsInRegion(region));
    return;
  }

  const defaultAnswers: ImportAnswers = {
    authSelections: 'userPoolOnly',
    resourceName: `${projectName}${shortId}`,
  };

  const answers: ImportAnswers = { ...defaultAnswers };
  let importSucceeded = false; // We set this variable if app client selection goes right

  const enquirer = new Enquirer<ImportAnswers>(undefined, defaultAnswers);

  const questionParameters: ImportParameters = {
    userPoolList: userPoolChoices,
    webClients: [],
    nativeClients: [],
  };

  // // Resource name
  // const resourceNameQuestion = {
  //   type: 'input',
  //   name: 'resourceName',
  //   message: importMessages.Questions.ResourceName,
  //   required: true,
  //   validate(value: string) {
  //     const regex = new RegExp('^([a-zA-Z0-9]){1,128}$');
  //     return regex.test(value) ? true : importMessages.Questions.ResourceNameValidation;
  //   },
  // };

  // const { resourceName } = await enquirer.prompt(resourceNameQuestion);
  // answers.resourceName = resourceName;

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
      const oauthResult = await appClientsOAuthPropertiesMatching(context, enquirer, answers.appClientWeb!, answers.appClientNative!);

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

  // Import questions succeeded, create the create the required CLI resource state from the answers.

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

  console.log(JSON.stringify(answers, null, 2));
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
  }

  questionParameters.bothAppClientsWereAutoSelected = autoSelected === 2;
};

const appClientsOAuthPropertiesMatching = async (
  context: $TSContext,
  enquirer: Enquirer<ImportAnswers>,
  appClientWeb: UserPoolClientType,
  appClientNative: UserPoolClientType,
): Promise<OAuthResult> => {
  // Here both clients having some federation configured, so get the intersection of the providers, since we can only import common ones.
  const sortedAppClientWebNames = [...appClientWeb.SupportedIdentityProviders!].sort();
  const sortedAppClientNativeNames = [...appClientNative.SupportedIdentityProviders!].sort();
  const commonProviders = _.intersection(sortedAppClientWebNames, sortedAppClientNativeNames);

  if (_.isEmpty(commonProviders)) {
    context.print.error(importMessages.OAuth.NoCommonProvidersFound);

    showValidationTable(
      context,
      importMessages.OAuth.ConfiguredIdentityProviders,
      appClientWeb,
      appClientNative,
      appClientWeb.SupportedIdentityProviders!,
      appClientNative.SupportedIdentityProviders!,
    );

    return {
      isValid: false,
    };
  }

  // Compare the app client properties, they must match, otherwise show what is not matching. For convenience we show all the properties that are not matching,
  // not just the first mismatch.
  let callbackUrlMatching = isArraysEqual(appClientWeb.CallbackURLs!, appClientNative.CallbackURLs!);
  let logoutUrlsMatching = isArraysEqual(appClientWeb.LogoutURLs!, appClientNative.LogoutURLs!);
  let allowedOAuthFlowsMatching = isArraysEqual(appClientWeb.AllowedOAuthFlows!, appClientNative.AllowedOAuthFlows!);
  let allowedOAuthScopesMatching = isArraysEqual(appClientWeb.AllowedOAuthScopes!, appClientNative.AllowedOAuthScopes!);
  let allowedOAuthFlowsUserPoolClientMatching =
    appClientWeb.AllowedOAuthFlowsUserPoolClient === appClientNative.AllowedOAuthFlowsUserPoolClient;
  let propertiesMatching =
    callbackUrlMatching &&
    logoutUrlsMatching &&
    allowedOAuthFlowsMatching &&
    allowedOAuthScopesMatching &&
    allowedOAuthFlowsUserPoolClientMatching;

  if (!propertiesMatching) {
    context.print.error(importMessages.OAuth.SomePropertiesAreNotMatching);
    context.print.info('');

    if (!allowedOAuthFlowsUserPoolClientMatching) {
      showValidationTable(
        context,
        importMessages.OAuth.OAuthFlowEnabledForApplicationClient,
        appClientWeb,
        appClientNative,
        [appClientWeb.AllowedOAuthFlowsUserPoolClient?.toString() || ''],
        [appClientNative.CallbackURLs?.toString() || ''],
      );
    }

    if (!callbackUrlMatching) {
      showValidationTable(
        context,
        importMessages.OAuth.CallbackURLs,
        appClientWeb,
        appClientNative,
        appClientWeb.CallbackURLs!,
        appClientNative.CallbackURLs!,
      );
    }

    if (!logoutUrlsMatching) {
      showValidationTable(
        context,
        importMessages.OAuth.LogoutURLs,
        appClientWeb,
        appClientNative,
        appClientWeb.LogoutURLs!,
        appClientNative.LogoutURLs!,
      );
    }

    if (!allowedOAuthFlowsMatching) {
      showValidationTable(
        context,
        importMessages.OAuth.AllowedOAuthFlows,
        appClientWeb,
        appClientNative,
        appClientWeb.AllowedOAuthFlows!,
        appClientNative.AllowedOAuthFlows!,
      );
    }

    if (!allowedOAuthScopesMatching) {
      showValidationTable(
        context,
        importMessages.OAuth.AllowedOAuthScopes,
        appClientWeb,
        appClientNative,
        appClientWeb.AllowedOAuthScopes!,
        appClientNative.AllowedOAuthScopes!,
      );
    }

    return {
      isValid: false,
    };
  }

  // We have valid OAuth properties for the selected Application Clients at this point, let the customer select which OAuth providers they want to import
  // from the configured ones.
  const providerChoices = commonProviders.map(p => ({
    message: p,
    value: p,
    selected: true,
  }));

  const providersSelectionQuestion = {
    type: 'multiselect',
    name: 'oauthProviders',
    message: importMessages.Questions.SelectOAuthProviders,
    required: true,
    initial: providerChoices.map(c => c.value),
    choices: providerChoices,
  };

  const { oauthProviders } = await enquirer.prompt(providersSelectionQuestion);

  // Don't return any OAuth properties is no OAuth providers were selected
  if (oauthProviders?.length === 0) {
    return {
      isValid: true,
    };
  }

  return {
    isValid: true,
    oauthProviders,
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
  webValues: string[],
  nativeValues: string[],
) => {
  const tableOptions = [[appClientWeb.ClientName!, appClientNative.ClientName!]];
  const webNames = [...webValues].sort();
  const nativeNames = [...nativeValues].sort();
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
