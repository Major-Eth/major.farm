/******************************************************************************
**	@Author:				Thomas Bouder <Tbouder>
**	@Email:					Tbouder@protonmail.com
**	@Date:					Friday April 23rd 2021
**	@Filename:				StrategyYVBoost.js
******************************************************************************/

import	React, {useState, useEffect, useCallback}	from	'react';
import	useCurrencies								from	'contexts/useCurrencies';
import	{toAddress, bigNumber}						from	'utils';
import	{ethers}									from	'ethers';
import	SectionRemove								from	'components/StrategyCard/SectionRemove'
import	SectionHead									from	'components/StrategyCard/SectionHead'
import	SectionFoot									from	'components/StrategyCard/SectionFoot'
import	Group, {GroupElement}						from	'components/StrategyCard/Group'
import	* as api									from	'utils/API';
import	methods										from	'utils/methodsSignatures';

async function	PrepareStrategyYearnV1(parameters, address, network) {
	let		timestamp = undefined;
	const	normalTx = await api.retreiveTxFrom(network, address);
	const	erc20Tx = await api.retreiveErc20TxFrom(network, address);

	async function	computeFees() {
		const	cumulativeFees = (
			normalTx
				.filter(tx => (
					(
						toAddress(tx.from) === toAddress(address) &&
					toAddress(tx.to) === toAddress(parameters.contractAddress) &&
					tx.input.startsWith(methods.YEARNV1_DEPOSIT)
					)
				||
				(
					toAddress(tx.from) === toAddress(address) &&
					toAddress(tx.to) === toAddress(parameters.contractAddress) &&
					tx.input.startsWith(methods.YEARNV1_WITHDRAW)
				)
				||
				(
					tx.input.startsWith(methods.STANDARD_APPROVE) &&
					(tx.input.toLowerCase()).includes((parameters.contractAddress.slice(2)).toLowerCase())
				)
				)).reduce((accumulator, tx) => {
					const	gasUsed = bigNumber.from(tx.gasUsed);
					const	gasPrice = bigNumber.from(tx.gasPrice);
					const	gasUsedPrice = gasUsed.mul(gasPrice);
					return bigNumber.from(accumulator).add(gasUsedPrice);
				}, bigNumber.from(0))
		);
		return (Number(ethers.utils.formatUnits(cumulativeFees, 18)));
	}

	async function	computeSeeds() {
		const	cumulativeSeeds = (
			erc20Tx
				.filter(tx => (
					(toAddress(tx.to) === toAddress(parameters.contractAddress))
				&&
				(tx.tokenSymbol === parameters.underlyingTokenSymbol)
				)).reduce((accumulator, tx) => {
					if (timestamp === undefined || timestamp > tx.timeStamp) {
						timestamp = tx.timeStamp;
					}
					return bigNumber.from(accumulator).add(tx.value);
				}, bigNumber.from(0))
		);
		return Number(ethers.utils.formatUnits(cumulativeSeeds, parameters.underlyingTokenDecimal || 18));
	}

	async function	computeCrops() {
		const	cumulativeCrops = (
			erc20Tx
				.filter(tx => (
					(toAddress(tx.from) === toAddress('0x0000000000000000000000000000000000000000'))
				&&
				(toAddress(tx.to) === toAddress(address))
				&&
				(tx.tokenSymbol === `y${parameters.underlyingTokenSymbol}`)
				)).reduce((accumulator, tx) => {
					return bigNumber.from(accumulator).add(tx.value);
				}, bigNumber.from(0))
		);
		return Number(ethers.utils.formatUnits(cumulativeCrops, parameters.underlyingTokenDecimal || 18));
	}

	async function	computeHarvest() {
		const	cumulativeHarvest = (
			erc20Tx
				.filter(tx => (
					(toAddress(tx.from) === toAddress(parameters.contractAddress)) &&
				(toAddress(tx.to) === toAddress(address)) &&
				(tx.tokenSymbol === parameters.underlyingTokenSymbol)
				)).reduce((accumulator, tx) => {
					return bigNumber.from(accumulator).add(tx.value);
				}, bigNumber.from(0))
		);
		return Number(ethers.utils.formatUnits(cumulativeHarvest, parameters.underlyingTokenDecimal || 18));
	}


	const	fees = await computeFees();
	const	initialCrops = await computeCrops();
	const	initialSeeds = await computeSeeds();
	const	harvest = await computeHarvest();

	return {
		fees,
		initialSeeds,
		initialCrops,
		harvest,
		timestamp,
	}
}

function	StrategyYearnV1({parameters, network, address, uuid, fees, initialSeeds, initialCrops, harvest, date}) {
	const	{tokenPrices, currencyNonce} = useCurrencies();

	const	[isHarvested, set_isHarvested] = useState(false);

	const	[APY, set_APY] = useState(0);
	const	[result, set_result] = useState(0);
	const	[underlyingEarned, set_underlyingEarned] = useState(0);
	const	[totalFeesEth] = useState(fees);

	const	[ethToBaseCurrency, set_ethToBaseCurrency] = useState(tokenPrices['eth']?.price || 0);
	const	[underlyingToBaseCurrency, set_underlyingToBaseCurrency] = useState(tokenPrices[parameters.underlyingTokenCgID]?.price || 0);
		
	const retrieveShareValue = useCallback(async () => {
		const	provider = new ethers.providers.AlchemyProvider('homestead', process.env.ALCHEMY_KEY)
		const	ABI = ['function getPricePerFullShare() external view returns (uint256)']
		const	smartContract = new ethers.Contract(parameters.contractAddress, ABI, provider)
		const	getPricePerFullShare = await smartContract.getPricePerFullShare();
		const	share = initialCrops * (getPricePerFullShare / 1e18)
		set_underlyingEarned(share)
	}, [initialCrops, parameters.contractAddress]);

	useEffect(() => {
		if (harvest > 0 && underlyingEarned === 0) {
			set_isHarvested(true);
		}
	}, [harvest, underlyingEarned])

	useEffect(() => {
		set_ethToBaseCurrency(tokenPrices['eth']?.price || 0);
		set_underlyingToBaseCurrency(tokenPrices[parameters.underlyingTokenCgID]?.price || 0);
		retrieveShareValue();
	}, [currencyNonce, parameters.underlyingTokenCgID, retrieveShareValue, tokenPrices]);

	useEffect(() => {
		if (harvest > 0 && initialCrops === 0) {
			set_result(((harvest - initialSeeds) * underlyingToBaseCurrency) - (totalFeesEth * ethToBaseCurrency));
		} else {
			set_result(
				((underlyingEarned - initialSeeds) * underlyingToBaseCurrency) -
				(totalFeesEth * ethToBaseCurrency)
			);
		}
	}, [ethToBaseCurrency, underlyingToBaseCurrency, underlyingEarned, totalFeesEth, harvest, initialCrops, initialSeeds])

	useEffect(() => {
		const	vi = initialSeeds * underlyingToBaseCurrency;
		const	vf = result + vi;
		set_APY((vf - vi) / vi * 100)
	}, [ethToBaseCurrency, initialSeeds, result, underlyingToBaseCurrency])

	return (
		<div className={'flex flex-col col-span-1 rounded-lg shadow bg-dark-600 p-6 relative'}>
			<SectionRemove uuid={uuid} />
			<SectionHead
				network={network}
				parameters={parameters}
				address={address}
				date={date}
				APY={APY} />
			<div className={'space-y-8'}>
				<Group title={'Seeds'}>
					<GroupElement
						network={network}
						image={parameters.underlyingTokenIcon}
						label={parameters.underlyingTokenSymbol}
						address={parameters.underlyingTokenAddress}
						amount={parseFloat(initialSeeds.toFixed(10))}
						value={(initialSeeds * underlyingToBaseCurrency).toFixed(2)} />
				</Group>

				<Group title={'Crops'}>
					<GroupElement
						network={network}
						image={parameters.tokenIcon}
						label={`y${parameters.underlyingTokenSymbol}`}
						address={parameters.contractAddress}
						amount={parseFloat(initialCrops.toFixed(10))}
						value={(initialSeeds * underlyingToBaseCurrency).toFixed(2)} />
				</Group>

				{isHarvested ?
					<>
						<Group title={'Yield'}>
							<GroupElement
								network={network}
								image={parameters.underlyingTokenIcon}
								label={parameters.underlyingTokenSymbol}
								address={parameters.contractAddress}
								amount={parseFloat((underlyingEarned - initialSeeds).toFixed(10))}
								value={((underlyingEarned - initialSeeds) * underlyingToBaseCurrency).toFixed(2)} />
						</Group>
						<Group title={'Harvest'}>
							<GroupElement
								network={network}
								image={parameters.underlyingTokenIcon}
								label={parameters.underlyingTokenSymbol}
								address={parameters.underlyingTokenAddress}
								amount={parseFloat(harvest.toFixed(10))}
								value={(harvest * underlyingToBaseCurrency).toFixed(2)} />
							<GroupElement
								network={network}
								image={'⛽️'}
								label={'Fees'}
								amount={parseFloat(totalFeesEth.toFixed(10))}
								value={-(totalFeesEth * ethToBaseCurrency).toFixed(2)} />
						</Group>
					</>
					: 
					<Group title={'Yield'}>
						<GroupElement
							network={network}
							image={parameters.underlyingTokenIcon}
							label={parameters.underlyingTokenSymbol}
							address={parameters.contractAddress}
							amount={parseFloat((underlyingEarned - initialSeeds).toFixed(10))}
							value={((underlyingEarned - initialSeeds) * underlyingToBaseCurrency).toFixed(2)} />
						<GroupElement
							network={network}
							image={'⛽️'}
							label={'Fees'}
							amount={parseFloat(totalFeesEth.toFixed(10))}
							value={-(totalFeesEth * ethToBaseCurrency).toFixed(2)} />
					</Group>
				}
			</div>

			<SectionFoot result={result} />
		</div>
	)
}

export {PrepareStrategyYearnV1};
export default StrategyYearnV1;