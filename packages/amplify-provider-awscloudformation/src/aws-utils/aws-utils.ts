import assert from 'assert';
import { $TSAny, $TSObject } from 'amplify-cli-core';
import { PaginationKeyType } from 'aws-sdk/clients/cognitoidentityserviceprovider';

export const pagedAWSCall = async <TAPIResult extends { NextToken?: PaginationKeyType }, TData>(
  action: $TSAny,
  params: $TSObject,
  accessor: (TAPIResult) => TData[],
): Promise<TData[]> => {
  assert(action, 'missing argument: action');
  assert(accessor, 'missing argument: accessor');

  let result: TData[] = [];
  let response: TAPIResult;

  do {
    response = await action({
      ...params,
      NextToken: response ? response.NextToken : undefined,
    }).promise();

    if (response && accessor(response)) {
      result = result.concat(accessor(response));
    }
  } while (response && !!response.NextToken);

  return result;
};
