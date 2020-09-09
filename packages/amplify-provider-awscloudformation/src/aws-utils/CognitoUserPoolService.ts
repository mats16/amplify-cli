import { $TSAny, $TSContext } from 'amplify-cli-core';
import { ICognitoUserPoolService } from 'amplify-util-import';
import { CognitoIdentityServiceProvider } from 'aws-sdk';
import {
  IdentityProviderType,
  ListIdentityProvidersResponse,
  ListUserPoolClientsResponse,
  ListUserPoolsResponse,
  ProviderDescription,
  UserPoolClientDescription,
  UserPoolClientListType,
  UserPoolClientType,
  UserPoolDescriptionType,
  UserPoolType,
} from 'aws-sdk/clients/cognitoidentityserviceprovider';
import configurationManager from '../configuration-manager';
import { pagedAWSCall } from './aws-utils';

export const createCognitoUserPoolService = async (context: $TSContext, options: $TSAny): Promise<CognitoUserPoolService> => {
  let credentials = {};

  try {
    credentials = await configurationManager.loadConfiguration(context);
  } catch (e) {
    // could not load credentials
  }

  const cognito = new CognitoIdentityServiceProvider({ ...credentials, ...options });

  return new CognitoUserPoolService(cognito);
};

export class CognitoUserPoolService implements ICognitoUserPoolService {
  private cachedUserPoolIds: Array<UserPoolDescriptionType> = [];

  public constructor(private cognito: CognitoIdentityServiceProvider) {}

  public async listUserPools(): Promise<UserPoolDescriptionType[]> {
    if (this.cachedUserPoolIds.length === 0) {
      const result = await pagedAWSCall<ListUserPoolsResponse, UserPoolDescriptionType>(
        this.cognito.listUserPools.bind(this.cognito),
        {
          MaxResults: 60,
        },
        (response: ListUserPoolsResponse) => response.UserPools,
      );

      this.cachedUserPoolIds.push(...result);
    }

    return this.cachedUserPoolIds;
  }

  public async getUserPoolDetails(userPoolId: string): Promise<UserPoolType> {
    const result = await this.cognito
      .describeUserPool({
        UserPoolId: userPoolId,
      })
      .promise();

    return result.UserPool;
  }

  public async listUserPoolClients(userPoolId: string): Promise<UserPoolClientType[]> {
    const userPoolClients = await pagedAWSCall<ListUserPoolClientsResponse, UserPoolClientDescription>(
      this.cognito.listUserPoolClients.bind(this.cognito),
      {
        UserPoolId: userPoolId,
        MaxResults: 60,
      },
      (response: ListUserPoolClientsResponse) => response.UserPoolClients,
    );

    const userPoolClientDetails: UserPoolClientType[] = [];

    if (userPoolClients.length > 0) {
      const describeUserPoolClientPromises = userPoolClients.map(upc =>
        this.cognito
          .describeUserPoolClient({
            UserPoolId: userPoolId,
            ClientId: upc.ClientId,
          })
          .promise(),
      );

      const userPoolClientDetailsResults = await Promise.all(describeUserPoolClientPromises);

      userPoolClientDetails.push(...userPoolClientDetailsResults.map(response => response.UserPoolClient));
    }

    return userPoolClientDetails;
  }

  public async listUserPoolIdentityProviders(userPoolId: string): Promise<IdentityProviderType[]> {
    const identityProviders = await pagedAWSCall<ListIdentityProvidersResponse, ProviderDescription>(
      this.cognito.listIdentityProviders.bind(this.cognito),
      {
        UserPoolId: userPoolId,
        MaxResults: 60,
      },
      (response: ListIdentityProvidersResponse) => response.Providers,
    );

    const identityPoolDetails: IdentityProviderType[] = [];

    if (identityProviders.length > 0) {
      const describeIdentityProviderPromises = identityProviders.map(idp =>
        this.cognito
          .describeIdentityProvider({
            UserPoolId: userPoolId,
            ProviderName: idp.ProviderName,
          })
          .promise(),
      );

      const identityProviderDetailsResults = await Promise.all(describeIdentityProviderPromises);

      identityPoolDetails.push(...identityProviderDetailsResults.map(response => response.IdentityProvider));
    }

    return identityPoolDetails;
  }
}
