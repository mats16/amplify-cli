import { $TSAny, $TSContext } from 'amplify-cli-core';

import aws from './aws.js';
import _ from 'lodash';
const providerName = require('../constants').ProviderName;
import configurationManager from '../configuration-manager';
import fs from 'fs-extra';
import ora from 'ora';
import { pagedAWSCall } from './paged-call';
import { ListObjectsV2Output, ListObjectsV2Request, NextToken } from 'aws-sdk/clients/s3';

const minChunkSize = 5 * 1024 * 1024; // 5 MB https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3/ManagedUpload.html#minPartSize-property

export class S3 {
  private static instance: S3;
  private readonly context: $TSContext;
  private readonly s3: AWS.S3;
  private uploadState: {
    envName: string;
    s3Params: {
      Bucket: string;
    };
  };

  static async getInstance(context: $TSContext, options = {}): Promise<S3> {
    if (!S3.instance) {
      let cred = {};
      try {
        cred = await configurationManager.loadConfiguration(context);
      } catch (e) {
        // ignore missing config
      }

      S3.instance = new S3(context, cred, options);
    }
    return S3.instance;
  }

  private constructor(context, cred, options = {}) {
    this.context = context;
    this.s3 = new aws.S3({ ...cred, ...options });
  }

  private populateUploadState(): void {
    const projectDetails = this.context.amplify.getProjectDetails();
    const { envName } = this.context.amplify.getEnvInfo();
    const projectBucket = projectDetails.amplifyMeta.providers
      ? projectDetails.amplifyMeta.providers[providerName].DeploymentBucketName
      : projectDetails.teamProviderInfo[envName][providerName].DeploymentBucketName;

    this.uploadState = {
      envName,
      s3Params: {
        Bucket: projectBucket,
      },
    };
  }

  async uploadFile(s3Params, showSpinner: boolean = true) {
    // envName and bucket does not change during execution, cache them into a class level
    // field.
    if (this.uploadState === undefined) {
      this.populateUploadState();
    }
    let spinner = showSpinner ? ora('Uploading files...') : undefined;

    const augmentedS3Params = {
      ...s3Params,
      ...this.uploadState.s3Params,
    };
    let uploadTask;
    try {
      showSpinner && spinner.start('Uploading files...');
      if (
        (s3Params.Body instanceof fs.ReadStream && fs.statSync(s3Params.Body.path).size > minChunkSize) ||
        (Buffer.isBuffer(s3Params.Body) && s3Params.Body.length > minChunkSize)
      ) {
        uploadTask = this.s3.upload(augmentedS3Params);
        uploadTask.on('httpUploadProgress', max => {
          if (showSpinner) spinner.text = `Uploading Files...${Math.round((max.loaded / max.total) * 100)}%`;
        });
      } else {
        uploadTask = this.s3.putObject(augmentedS3Params);
      }
      await uploadTask.promise();
      return this.uploadState.s3Params.Bucket;
    } finally {
      showSpinner && spinner.stop();
    }
  }

  async getFile(s3Params, envName = this.context.amplify.getEnvInfo().envName) {
    const projectDetails = this.context.amplify.getProjectDetails();
    const projectBucket = projectDetails.teamProviderInfo[envName][providerName].DeploymentBucketName;
    s3Params.Bucket = projectBucket;

    const result = await this.s3.getObject(s3Params).promise();
    return result.Body;
  }

  async createBucket(bucketName, throwIfExists: boolean = false): Promise<string | void> {
    // Check if bucket exists;
    const params = {
      Bucket: bucketName,
    };

    if (!(await this.ifBucketExists(bucketName))) {
      this.context.print.warning(
        'The specified S3 bucket to store the CloudFormation templates is not present. We are creating one for you....',
      );
      this.context.print.warning(`Bucket name: ${bucketName}`);
      await this.s3.createBucket(params).promise();
      await this.s3.waitFor('bucketExists', params).promise();
      this.context.print.success('S3 bucket successfully created');
      return bucketName;
    } else if (throwIfExists) {
      throw new Error(`Bucket ${bucketName} already exists`);
    }
  }

  async getAllObjectKeys(bucketName, continuationToken = null) {
    const result = await pagedAWSCall<ListObjectsV2Output, { Key: string }, NextToken>(
      async (param: $TSAny, nextToken?: NextToken) => {
        const parmaWithNextToken: ListObjectsV2Request = nextToken ? { ...param, ContinuationToken: nextToken } : param;
        return await this.s3.listObjectsV2(parmaWithNextToken).promise();
      },
      {
        Bucket: bucketName,
      },
      (response?: ListObjectsV2Output) => response.Contents?.map(r => ({ Key: r.Key })),
      async (response?: ListObjectsV2Output) => (response && response.IsTruncated ? response.NextContinuationToken : undefined),
    );
    return result;
  }

  public async deleteAllObjects(bucketName): Promise<void> {
    const allObjects = await this.getAllObjectKeys(bucketName);
    const chunkedResult = _.chunk(allObjects, 1000);
    for (let chunk of chunkedResult) {
      await this.s3
        .deleteObjects({
          Bucket: bucketName,
          Delete: {
            Objects: chunk,
          },
        })
        .promise();
    }
  }

  public async deleteS3Bucket(bucketName) {
    if (await this.ifBucketExists(bucketName)) {
      await this.deleteAllObjects(bucketName);
      await this.s3.deleteBucket({ Bucket: bucketName }).promise();
    }
  }

  public async ifBucketExists(bucketName: string) {
    try {
      await this.s3
        .headBucket({
          Bucket: bucketName,
        })
        .promise();
      return true;
    } catch (e) {
      if (e.statusCode === 404) {
        return false;
      }
      throw e;
    }
  }
}
