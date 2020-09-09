import { IdentityPool, IdentityPoolShortDescription } from 'aws-sdk/clients/cognitoidentity';

export interface IIdentityPoolService {
  listIdentityPools(): Promise<IdentityPoolShortDescription[]>;
  listIdentityPoolDetails(): Promise<IdentityPool[]>;
}
