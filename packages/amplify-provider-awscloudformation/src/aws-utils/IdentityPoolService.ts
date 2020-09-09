import { $TSAny, $TSContext } from 'amplify-cli-core';
import { IIdentityPoolService } from 'amplify-util-import';
import { CognitoIdentity } from 'aws-sdk';
import { IdentityPool, IdentityPoolShortDescription, ListIdentityPoolsResponse } from 'aws-sdk/clients/cognitoidentity';
import configurationManager from '../configuration-manager';
import { pagedAWSCall } from './aws-utils';

export const createIdentityPoolService = async (context: $TSContext, options: $TSAny): Promise<IdentityPoolService> => {
  let credentials = {};

  try {
    credentials = await configurationManager.loadConfiguration(context);
  } catch (e) {
    // could not load credentials
  }

  const cognitoIdentity = new CognitoIdentity({ ...credentials, ...options });

  return new IdentityPoolService(cognitoIdentity);
};

export class IdentityPoolService implements IIdentityPoolService {
  private cachedIdentityPoolIds: IdentityPoolShortDescription[] = [];
  private cachedIdentityPoolDetails: IdentityPool[] = [];

  public constructor(private cognitoIdentity: CognitoIdentity) {}

  public async listIdentityPools(): Promise<IdentityPoolShortDescription[]> {
    if (this.cachedIdentityPoolIds.length === 0) {
      const result = await pagedAWSCall<ListIdentityPoolsResponse, IdentityPoolShortDescription>(
        this.cognitoIdentity.listIdentityPools.bind(this.cognitoIdentity),
        {
          MaxResults: 60,
        },
        (response: ListIdentityPoolsResponse) => response.IdentityPools,
      );

      this.cachedIdentityPoolIds.push(...result);
    }

    return this.cachedIdentityPoolIds;
  }

  public async listIdentityPoolDetails(): Promise<IdentityPool[]> {
    if (this.cachedIdentityPoolDetails.length === 0) {
      const identityPools = await this.listIdentityPools();

      const identityPoolDetails = [];

      if (identityPools.length > 0) {
        const describeIdentityPoolPromises = identityPools.map(idp =>
          this.cognitoIdentity
            .describeIdentityPool({
              IdentityPoolId: idp.IdentityPoolId,
            })
            .promise(),
        );

        const identityPoolDetailResults = await Promise.all(describeIdentityPoolPromises);

        identityPoolDetails.push(...identityPoolDetailResults);
      }

      this.cachedIdentityPoolDetails.push(...identityPoolDetails);
    }

    return this.cachedIdentityPoolDetails;
  }
}
